import { Controller, Post, Param, Headers, Req, Res, HttpCode, Body, Get } from '@nestjs/common';
import { ImageRelayService } from './image-relay.service';

@Controller('api')
export class ImageRelayController {
  constructor(private readonly relay: ImageRelayService) {}
  private worker(auth?: string, header?: string) { return header?.trim() || auth?.replace(/^Bearer\s+/i, '').trim() || ''; }
  @Post('image-jobs/claim')
  async claim(@Headers('authorization') auth: string, @Headers('x-worker-id') workerId: string, @Body() body: any, @Res() res: any) {
    const worker = this.worker(auth, workerId || body?.workerId);
    const job = await this.relay.claim(worker);
    if (!job) return res.status(204).send();
    return res.status(200).json({ job: { id: job.id, imageUrl: job.image_url, productId: job.product_id } });
  }
  @Post('image-jobs/:id/upload')
  upload(@Param('id') id: string, @Headers('authorization') auth: string, @Headers('x-worker-id') workerId: string, @Headers('content-type') type: string, @Req() req: any) { return this.relay.upload(id, this.worker(auth, workerId), type, req); }
  @Post('image-jobs/:id/complete')
  complete(@Param('id') id: string, @Headers('authorization') auth: string, @Headers('x-worker-id') workerId: string, @Body() body: any) { return this.relay.complete(id, this.worker(auth, workerId || body?.workerId), body); }
  @Post('image-jobs/:id/fail')
  fail(@Param('id') id: string, @Headers('authorization') auth: string, @Headers('x-worker-id') workerId: string, @Body() body: any) { return this.relay.fail(id, this.worker(auth, workerId || body?.workerId), body?.error); }
  @Get('image-assets/:id')
  async asset(@Param('id') id: string, @Res() res: any) { const { asset, stream } = await this.relay.stream(id); res.setHeader('Content-Type', asset.content_type); res.setHeader('Content-Length', asset.bytes); stream.pipe(res); }
}
