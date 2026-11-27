import {svgResultInfo, gifResultInfo, decodeImageResult} from './image-result.mjs';

// Gemini returns image bytes inline or in embedded Markdown data images.
const ratios = new Set(['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']);
const pixels = new Map();
for (const [w,h,ratio] of [[1024,1024,'1:1'],[1536,1024,'3:2'],[1024,1536,'2:3'],[1152,1536,'3:4'],[1536,864,'16:9'],[864,1536,'9:16'],[2048,864,'21:9']]) {
  for (const n of [1,2,4]) pixels.set(`${w*n}x${h*n}`, {imageSize:`${n}K`, aspectRatio:ratio});
}
const maxImageBytes = 24 * 1024 * 1024, maxResponseBytes = 40 * 1024 * 1024;
const invalid = (message, code='invalid_gemini_request') => Object.assign(new Error(message), {code});

export function geminiImageEndpoint(base, model) {
  let url;
  try { url = new URL(base); } catch { throw invalid('Gemini 供应商地址无效'); }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Gemini 地址应为不带凭据、查询参数或片段的 HTTP(S) 地址');
  if (url.hostname==='generativelanguage.googleapis.com' && url.origin!=='https://generativelanguage.googleapis.com') throw invalid('Google Gemini 官方地址必须使用标准 HTTPS');
  const id = typeof model === 'string' ? model.replace(/^models\//,'') : '';
  if (!/^[a-z\d][a-z\d._-]{0,119}$/i.test(id)) throw invalid('Gemini 模型 ID 无效（填写模型名或 models/模型名）');
  const path = url.pathname.replace(/\/+$/,'');
  const prefix = url.origin==='https://generativelanguage.googleapis.com' && path==='/v1beta/openai' ? '' : path.replace(/\/v1(?:beta)?$/,'');
  url.pathname = `${prefix}/v1beta/models/${encodeURIComponent(id)}:generateContent`;
  return url;
}

const knownInput = new Set('prompt userText planNote conversationId sessionId providerId model size quality n seconds endpoint protocol mode referenceUrl referenceUrls image images mask aspectRatio aspect_ratio source reason count reference_url'.split(' '));
export function validateGeminiParams(input, defaults) {
  if (Object.keys(input).some(key => !knownInput.has(key))) throw invalid('Gemini 请求含不支持的参数；请使用工作台支持的生成字段');
  if (input.count != null && input.count !== 1 && input.count !== '1') throw invalid('Gemini 每次只支持生成 1 张图片');
  if (input.n != null && input.n !== 1 && input.n !== '1') throw invalid('Gemini 每次只支持生成 1 张图片');
  if (input.mask) throw invalid('Gemini 不支持像素蒙版；请使用图片编辑协议');
  if (input.quality || input.seconds) throw invalid('Gemini 不支持 quality 或视频时长，请使用分辨率和宽高比');
  const normalizeRatio=value => typeof value==='string' && value.trim().toLowerCase()==='auto' ? 'auto' : value;
  const camel=normalizeRatio(input.aspectRatio), snake=normalizeRatio(input.aspect_ratio);
  if (camel != null && snake != null && camel!==snake) throw invalid('Gemini 宽高比参数冲突');
  const text = String(input.size ?? defaults.size).trim().toUpperCase();
  const pixel = pixels.get(text.toLowerCase().replace(/\s*[×x]\s*/g,'x'));
  const match = /^([124]K)(?:\s*[·@ ]\s*(\d{1,2}:\d{1,2}))?$/.exec(text);
  if (!pixel && !match) throw invalid('Gemini 仅支持 1K / 2K / 4K 和工作台中的标准像素尺寸');
  const tier = pixel?.imageSize || match[1], ratio = pixel?.aspectRatio || match?.[2];
  const requested = camel ?? snake;
  if (requested && requested!=='auto' && ratio && requested !== ratio) throw invalid('Gemini 尺寸和宽高比不一致');
  if (ratio && !ratios.has(ratio)) throw invalid('Gemini 不支持此宽高比');
  const chosen = requested ?? ratio ?? '1:1';
  if (chosen!=='auto' && !ratios.has(chosen)) throw invalid('Gemini 不支持此宽高比');
  const imageConfig = chosen==='auto' ? {} : {aspectRatio:chosen};
  if (/^(?:models\/)?gemini-2\.5-flash-image(?:-|$)/i.test(defaults.model)) {
    if (tier !== '1K') throw invalid('Gemini 2.5 Flash Image 分辨率固定为 1K');
    return imageConfig;
  }
  return {...imageConfig, imageSize:tier};
}

function imageMime(bytes) {
  if (bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16) && bytes.readUInt32BE(20)) return 'image/png';
  if (bytes.length>=16 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (bytes.length>=20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'image/webp';
  return '';
}
export function geminiInlineBytes(bytes) {
  const mimeType = imageMime(bytes);
  if (!mimeType || bytes.length>maxImageBytes) throw invalid('Gemini 图片需提供有效的 PNG、JPEG 或 WebP 数据，单图不能超过 24 MiB');
  return {mimeType,data:bytes.toString('base64')};
}
function decodeImage(data, declared, allowImageFiles = false) {
  if (typeof data!=='string' || !data || data.length>maxImageBytes*1.5) throw invalid('Gemini 图片数据为空或过大');
  const clean=data.replace(/\s+/g,'');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length%4===1) throw invalid('Gemini 图片不是有效的 base64');
  const buffer=Buffer.from(clean,'base64');
  const mime=imageMime(buffer) || (allowImageFiles ? (gifResultInfo(buffer) || svgResultInfo(buffer))?.mime : '');
  if (!mime || buffer.length>maxImageBytes || (declared && String(declared).toLowerCase().replace(/^image\/jpg$/,'image/jpeg')!==mime)) throw invalid('Gemini 图片类型或字节无效');
  return {kind:'b64', mime, buffer};
}
export function geminiInlineInput(value) {
  if (typeof value!=='string') throw invalid('Gemini 参考图需要真实图片字节');
  const match=/^data:(image\/[a-z0-9.+-]+);base64,/i.exec(value);
  const item=decodeImage(match?value.slice(match[0].length):value,match?.[1]);
  return {mimeType:item.mime,data:item.buffer.toString('base64')};
}
function markdownImage(text) {
  if (typeof text !== 'string') return null;
  const m=/!\[[^\[\]\r\n]*\]\(\s*<?data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n\t ]+)(?:>\s*)?\)/i.exec(text);
  return m ? decodeImage(m[2],m[1],true) : decodeImageResult(text);
}
function imageResult(payload) {
  if (payload?.promptFeedback?.blockReason) throw invalid('Gemini 已拦截此次请求，未返回图片','upstream_blocked');
  const blocked=c=>/^(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT|SPII|RECITATION|IMAGE_(?:SAFETY|PROHIBITED_CONTENT|RECITATION))$/.test(c?.finishReason) || (Array.isArray(c?.safetyRatings) && c.safetyRatings.some(r=>r?.blocked));
  const candidates=Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (blocked(candidate)) continue;
    const parts=Array.isArray(candidate?.content?.parts) ? candidate.content.parts.filter(p=>p && !p.thought) : [];
    for (const part of parts) {
      const inline=part.inlineData || part.inline_data;
      if (inline) return decodeImage(inline.data, inline.mimeType || inline.mime_type, true);
    }
    for (const part of parts) { const image=markdownImage(part.text); if (image) return image; }
  }
  if (candidates.length && candidates.every(blocked)) throw invalid('Gemini 已拦截此次生成，未返回图片','upstream_blocked');
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    if (choice?.finish_reason==='content_filter') continue;
    const content=choice?.message?.content;
    for (const text of Array.isArray(content)?content.map(p=>p?.text):[content]) {const image=markdownImage(text);if(image)return image;}
  }
  throw invalid('Gemini 没有返回可保存的图片；仅接受 inlineData 或 Markdown 内嵌图片','upstream_no_image_field');
}
async function readResponse(response) {
  const chunks=[];let size=0;
  for await (const chunk of response.body || []) {
    size+=chunk.length;if(size>maxResponseBytes) throw invalid('Gemini 响应过大','upstream_too_large');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return null;}
}
function safeMessage(value, apiKey) {
  if (typeof value !== 'string') return '';
  return value.split(apiKey).join('[redacted]').replace(/data:[^\s,]+;base64,\S*/ig,'[image]').replace(/[a-z0-9+/_=-]{32,}/ig,'[redacted]').slice(0,400);
}
export async function generateGeminiImage({url, apiKey, model, prompt, imageConfig, images, signal, timeoutMs}) {
  const started=Date.now(), controller=new AbortController();
  const abort=()=>controller.abort();
  const timer=setTimeout(abort,timeoutMs);
  signal.addEventListener('abort',abort,{once:true});
  let status=0;
  try {
    if(signal.aborted) abort();
    const auth=url.origin==='https://generativelanguage.googleapis.com' ? {'x-goog-api-key':apiKey} : {authorization:`Bearer ${apiKey}`};
    const response=await fetch(url,{method:'POST',redirect:'manual',signal:controller.signal,headers:{...auth,'content-type':'application/json'},body:JSON.stringify({
      contents:[{role:'user',parts:[{text:prompt},...images.map(inlineData=>({inlineData}))]}],
      generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig}
    })});
    status=response.status;
    if(status>=300 && status<400) {await response.body?.cancel();throw invalid('Gemini 返回重定向；为保护供应商凭据，未跟随且未重试','upstream_redirect');}
    const payload=await readResponse(response);
    if(!response.ok || payload?.error) throw invalid(safeMessage(payload?.error?.message || payload?.message, apiKey) || `Gemini 上游返回 HTTP ${status}`,`upstream_${status}`);
    if(!payload) throw invalid('Gemini 上游返回非 JSON 响应','upstream_non_json');
    const image=imageResult(payload), usage={};
    for (const key of ['promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount','cachedContentTokenCount']) if(Number.isSafeInteger(payload.usageMetadata?.[key])) usage[key]=payload.usageMetadata[key];
    return {image, usage:Object.keys(usage).length?usage:null, elapsedMs:Date.now()-started};
  } catch(error) {
    const out = controller.signal.aborted
      ? invalid(signal.aborted?'已取消':`Gemini 请求超时（${Math.round(timeoutMs/1000)}s）`,signal.aborted?'cancelled':'upstream_timeout')
      : invalid(safeMessage(error?.message,apiKey) || 'Gemini 上游连接失败', error?.code || 'upstream_network');
    out.status=status;
    out.detail={kind:status?'upstream':'network',method:'POST',status,route:url.pathname,model,url:url.href,code:out.code||'upstream_network',body:out.message};
    throw out;
  } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
