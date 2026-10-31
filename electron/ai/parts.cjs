// Image parts in API messages (the 桌宠 sends a screenshot with a question). A message's content is a
// string, or a list of { type: 'text', text } and { type: 'image', mime, data /* base64 */ }. Checked here,
// before anything reaches a model; plain-string messages are not touched.

const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 6 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** First bytes of a real JPEG / PNG file, to see the data is what its mime says. */
const MAGIC = { 'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]), 'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

/**
 * Returns { arrays, error? }: `arrays` = how many messages use parts (the CLI drivers take none),
 * `error` = a Chinese line for the user when something is not allowed.
 */
function checkParts(messages) {
  let arrays = 0;
  let images = 0;
  if (!Array.isArray(messages)) return { arrays };
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    arrays++;
    if (m.role !== 'user') return { arrays, error: '图片只能放在用户的消息里。' };
    let useful = 0;
    for (const p of m.content) {
      if (p && p.type === 'text' && typeof p.text === 'string') { if (p.text) useful++; continue; }
      if (!p || p.type !== 'image') return { arrays, error: '消息里有不支持的内容类型。' };
      if (!MAGIC[p.mime]) return { arrays, error: '图片只支持 JPEG 或 PNG。' };
      if (typeof p.data !== 'string' || !p.data) return { arrays, error: '图片没有内容。' };
      if (p.data.length > MAX_IMAGE_B64) return { arrays, error: '单张图片超过 6 MB，请缩小后再发。' };
      if (!BASE64.test(p.data)) return { arrays, error: '图片数据不是有效的 Base64。' };
      const head = Buffer.from(p.data.slice(0, 8), 'base64');
      if (!head.subarray(0, MAGIC[p.mime].length).equals(MAGIC[p.mime])) return { arrays, error: '图片内容和声明的格式不符。' };
      if (++images > MAX_IMAGES) return { arrays, error: `一次最多发送 ${MAX_IMAGES} 张图片。` };
      useful++;
    }
    if (!useful) return { arrays, error: '消息内容是空的。' };
  }
  return { arrays };
}

module.exports = { checkParts, MAX_IMAGES, MAX_IMAGE_B64 };
