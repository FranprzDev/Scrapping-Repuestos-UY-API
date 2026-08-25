import { Controller, Post, Param, Headers, Req, Res, HttpCode, Body, Get, NotFoundException } from '@nestjs/common';
import { ImageRelayService } from './image-relay.service';
@Controller('api')
export class ImageRelayController {
 constructor(private readonly relay: ImageRelayService) {}
 private worker(h?:string) { return h?.replace(/^Bearer\s+/i,'') ?? ''; }
 @Post('image-jobs/claim') @HttpCode(200) claim(@Headers('authorization') auth:string){ return this.relay.claim(this.worker(auth)); }
 @Post('image-jobs/:id/upload') upload(@Param('id') id:string,@Headers('authorization') auth:string,@Headers('content-type') type:string,@Req() req:any){ return this.relay.upload(id,this.worker(auth),type,req); }
 @Post('image-jobs/:id/complete') complete(@Param('id') id:string,@Headers('authorization') auth:string,@Body() body:any){ return this.relay.complete(id,this.worker(auth),body); }
 @Post('image-jobs/:id/fail') fail(@Param('id') id:string,@Headers('authorization') auth:string,@Body() body:any){ return this.relay.fail(id,this.worker(auth),body?.error); }
 @Get('image-assets/:id') async asset(@Param('id') id:string,@Res() res:any){ const {asset,stream}=await this.relay.stream(id); res.setHeader('Content-Type',asset.content_type); res.setHeader('Content-Length',asset.bytes); stream.pipe(res); }
}
