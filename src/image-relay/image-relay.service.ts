import { Injectable, NotFoundException, UnauthorizedException, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { PostgresService } from '../scraping/jobs/postgres.service';

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export type ImageJob = { id:string; inventory_id:string; site:string; product_id:string; image_url:string; status:string; attempts:number; claimed_by?:string; claimed_at?:string; };

@Injectable()
export class ImageRelayService {
  private readonly root = process.env.IMAGE_STORAGE_ROOT ?? '/data/images';
  private readonly maxBytes = Number(process.env.IMAGE_MAX_BYTES ?? 10_485_760);
  private readonly retryLimit = Number(process.env.IMAGE_RETRY_LIMIT ?? 3);
  constructor(private readonly db: PostgresService) {}
  enabled() { return process.env.IMAGE_RELAY_ENABLED === 'true'; }
  private auth(token?: string) { const expected = process.env.IMAGE_WORKER_TOKEN; if (!expected || token !== expected) throw new UnauthorizedException('Token de worker invalido'); }
  private allowed(site: string) { const list = (process.env.IMAGE_RELAY_ALLOWED_SITES ?? '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean); return list.includes(site.toLowerCase()) || list.some(x => site.toLowerCase().includes(x)); }

  async enqueueForInventory(inventoryId: string, site: string, product: {imageUrl?:string; imageUrls?:string[]}) {
    if (!this.enabled() || !this.allowed(site)) return 0;
    const urls = [...new Set([...(product.imageUrls ?? []), product.imageUrl].filter((x): x is string => Boolean(x?.trim())))];
    for (const url of urls) await this.db.query(`INSERT INTO image_jobs (inventory_id, site, product_id, image_url) VALUES ($1,$2,$1,$3) ON CONFLICT (inventory_id,image_url) DO NOTHING`, [inventoryId, site, url]);
    return urls.length;
  }
  async claim(worker: string) { this.auth(worker); const result = await this.db.query<ImageJob>(`UPDATE image_jobs SET status='processing', claimed_by=$1, claimed_at=NOW(), attempts=attempts+1, updated_at=NOW() WHERE id=(SELECT id FROM image_jobs WHERE (status IN ('pending','retry_pending') OR (status='processing' AND claimed_at < NOW()-INTERVAL '15 minutes')) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [worker]); return result.rows[0]; }
  async upload(id: string, worker: string, contentType: string | undefined, req: NodeJS.ReadableStream) {
    this.auth(worker); if (!contentType || !allowedTypes.has(contentType.split(';')[0].trim())) throw new BadRequestException('Content-Type de imagen invalido');
    const job = await this.job(id); if (job.status === 'completed') return this.asset(id); if (job.claimed_by !== worker) throw new UnauthorizedException('Worker no autorizado para este job');
    const tmp = join(this.root, '.tmp', `${id}-${randomUUID()}`); await fs.mkdir(dirname(tmp), {recursive:true});
    let bytes=0; const hash=createHash('sha256'); const output=createWriteStream(tmp); try { for await (const chunk of req as AsyncIterable<Buffer>) { const buffer=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if(bytes > this.maxBytes) throw new PayloadTooLargeException('Imagen demasiado grande'); hash.update(buffer); if(!output.write(buffer)) await new Promise<void>(resolve => output.once('drain', resolve)); } await new Promise<void>((resolve,reject)=>{ output.end(()=>resolve()); output.once('error',reject); }); } catch (error) { output.destroy(); await fs.rm(tmp,{force:true}); throw error; }
    const key = `${id}/original`; const target=join(this.root,key); await fs.mkdir(dirname(target),{recursive:true}); await fs.rename(tmp,target); return {jobId:id, storageKey:key, bytes, sha256:hash.digest('hex'), contentType};
  }
  async complete(id:string, worker:string, body:any) { this.auth(worker); const job=await this.job(id); if(job.status==='completed') return this.asset(id); if (job.claimed_by !== worker) throw new UnauthorizedException('Worker no autorizado para este job'); if (!body?.sha256 || Number(body.bytes)<=0 || !allowedTypes.has(String(body.contentType ?? ''))) throw new BadRequestException('Metadata de imagen incompleta'); const key=`${id}/original`; const path=join(this.root,key); let stat; try { stat=await fs.stat(path); } catch { throw new BadRequestException('Upload no encontrado'); } if (stat.size !== Number(body.bytes)) throw new BadRequestException('Bytes de imagen no coinciden'); const digest=createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); if (digest.digest('hex') !== body.sha256) throw new BadRequestException('SHA-256 de imagen no coincide'); const result=await this.db.query(`INSERT INTO image_assets (inventory_id,image_job_id,source_url,storage_key,content_type,bytes,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (image_job_id) DO UPDATE SET updated_at=NOW() RETURNING *`,[job.inventory_id,id,job.image_url,key,body.contentType,body.bytes,body.sha256]); await this.db.query(`UPDATE image_jobs SET status='completed', completed_at=NOW(), updated_at=NOW(), claimed_by=$2 WHERE id=$1`,[id,worker]); return result.rows[0]; }
  async fail(id:string,worker:string,error:string) { this.auth(worker); const job=await this.job(id); const status=job.attempts < this.retryLimit ? 'retry_pending':'failed'; await this.db.query(`UPDATE image_jobs SET status=$2, last_error=$3, failed_at=NOW(), updated_at=NOW() WHERE id=$1 AND status <> 'completed'`,[id,status,String(error ?? 'error').slice(0,500)]); return {id,status}; }
  async asset(id:string) { const r=await this.db.query<any>('SELECT * FROM image_assets WHERE id=$1 OR image_job_id=$1',[id]); if(!r.rows[0]) throw new NotFoundException('Asset no encontrado'); return r.rows[0]; }
  async stream(id:string) { const asset=await this.asset(id); return {asset, stream:createReadStream(join(this.root,asset.storage_key))}; }
  private async job(id:string) { const r=await this.db.query<ImageJob>('SELECT * FROM image_jobs WHERE id=$1',[id]); if(!r.rows[0]) throw new NotFoundException('Image job no encontrado'); return r.rows[0]; }
}
