// A local, editable PowerPoint. The file tool owns path checks, approval and publication.
'use strict';

const definition = {
  name: 'create_presentation', toolId: 'write_file',
  description: '在工作文件夹新建可编辑的 PowerPoint (.pptx)，由萤火本地生成并校验。已有同名文件时请选择新文件名。slides 按顺序填写实际内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标 .pptx 路径，例如 项目汇报.pptx。' },
      slides: {
        type: 'array', description: '按演示顺序填写 1 到 40 页。',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '页标题，最多 60 字。' },
            bullets: { type: 'array', items: { type: 'string' }, description: '本页 0 到 6 条要点，每条最多 100 字。封面可留空。' },
          },
          required: ['title', 'bullets'],
        },
      },
    },
    required: ['path', 'slides'],
  },
};

function check(path, slides) {
  if (typeof path !== 'string' || !/\.pptx$/i.test(path)) return '请提供以 .pptx 结尾的文件路径。';
  if (!Array.isArray(slides) || !slides.length || slides.length > 40) return '演示文稿需要 1 到 40 页。';
  const validText = (s, max) => typeof s === 'string' && s.length <= 2 * max && s.trim() &&
    [...s].length <= max && !/[\u0000-\u001f\u007f\ufffe\uffff]/.test(s) && s.isWellFormed();
  for (const [i, slide] of slides.entries()) {
    if (!slide || !validText(slide.title, 60)) return `第 ${i + 1} 页需要 1 到 60 字的单行标题。`;
    if (!Array.isArray(slide.bullets) || slide.bullets.length > 6 || !slide.bullets.every(t => validText(t, 100))) {
      return `第 ${i + 1} 页可填 0 到 6 条单行要点，每条 1 到 100 字。`;
    }
  }
  return '';
}

async function render(slides) {
  const PptxGenJS = require('pptxgenjs');
  const JSZip = require('jszip');
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.title = slides[0].title;
  ppt.author = 'FireflyHarness';
  ppt.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei', lang: 'zh-CN' };
  for (const { title, bullets } of slides) {
    const slide = ppt.addSlide();
    slide.background = { color: 'F6F8FA' };
    slide.addText(title, {
      x: 0.8, y: bullets.length ? 0.45 : 2.25, w: 11.7, h: bullets.length ? 1.12 : 2.6,
      fontSize: bullets.length ? 30 : 38, bold: true, color: '173847', margin: 0, fit: 'shrink',
    });
    // Give longer points a larger share of the available height. Each remains editable.
    const weights = bullets.map(text => Math.ceil([...text].length / 30));
    const units = weights.reduce((sum, weight) => sum + weight, 0);
    let y = 1.75;
    bullets.forEach((text, i) => {
      const h = Math.min(1.35, 5.25 * weights[i] / units);
      slide.addText(text, { x: 0.9, y, w: 11.55, h: h - 0.06, margin: 0, valign: 'middle',
        fontSize: 21, color: '234451', bullet: { indent: 22 }, fit: 'shrink' });
      y += h;
    });
  }
  const bytes = await ppt.write({ outputType: 'nodebuffer', compression: true });
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  if (!zip.file('ppt/presentation.xml') || zip.file(/^ppt\/slides\/slide\d+\.xml$/).length !== slides.length) {
    throw new Error('PowerPoint 文件校验失败。');
  }
  return bytes;
}

module.exports = { definition, check, render };
