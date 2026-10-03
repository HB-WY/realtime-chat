import { request } from './http';

/**
 * 问后端「这个附件该怎么播」。
 *
 * 后端会顺带做两件事（都是幂等的，重复问不会重复转码）：
 *   · 已经能播的 → 告诉你 needed:false；
 *   · 播不了的 → 当场把文件排进 ffmpeg 转码队列，回 pending + 进度。
 *
 * 返回里的 `playUrl` 才是应该喂给 <video>/<audio> 的地址：
 *   · 不需要转码 → 就是原地址；
 *   · 需要转码 → /uploads/files/tc/<同名>.mp4|.mp3（转好之前取不到）。
 *
 * @returns {Promise<{needed:boolean, status:'not_needed'|'pending'|'ready'|'failed'
 *                    |'unsupported'|'unavailable', playUrl:string|null,
 *                    progress:number|null, error:string|null, reason:string}>}
 */
export function getMediaStatus(src) {
  return request(`/media/status?src=${encodeURIComponent(src)}`);
}

/** 诊断用：本地 ffmpeg 有没有就绪、转码队列里有多少活 */
export function getTranscodeInfo() {
  return request('/media/transcode');
}