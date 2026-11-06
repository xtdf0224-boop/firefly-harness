// Exercise the public import/confirm/list path with real temporary files and a fake picker.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = async function skillsImportChecks({ req, tmp, rm, write, eq, expect }) {
  const base = tmp('skills-import');
  const profile = path.join(base, 'profile');
  const src = path.join(base, 'demo');
  let selected = src;
  const electron = {
    app: { getPath: () => profile }, BrowserWindow: { fromWebContents: () => null },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
  };
  const filename = req.resolve('./electron/ai/skills.cjs');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports,
    require: (name) => name === 'electron' ? electron : req(name),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  }, { filename });
  const skills = mod.exports;
  const valid = (body) => `---\nname: demo\ndescription: fixture skill\n---\n${body}\n`;
  try {
    skills.createSkill('demo');
    skills.setEnabled('demo', false);
    const dest = path.join(profile, 'skills', 'demo');
    const old = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
    write(path.join(dest, 'keep.txt'), 'old companion');
    const invalid = [
      ['missing frontmatter', 'broken skill body'],
      ['missing description', '---\nname: demo\n---\nbody'],
      ['list description', '---\nname: demo\ndescription: [invalid]\n---\nbody'],
      ['blank description', '---\nname: demo\ndescription: "  "\n---\nbody'],
      ['oversized SKILL.md', valid('x'.repeat(201 * 1024))],
      ['source removed while awaiting confirmation', null],
    ];
    for (const [label, text] of invalid) {
      write(path.join(src, 'SKILL.md'), valid('valid before confirmation'));
      const picked = await skills.importSkill(null);
      expect(`${label}: the existing skill requires overwrite confirmation`, picked.conflict === 'demo' && !!picked.token, picked);
      if (text === null) fs.unlinkSync(path.join(src, 'SKILL.md'));
      else write(path.join(src, 'SKILL.md'), text);
      const result = skills.confirmImport(picked.token);
      expect(`${label}: import fails before replacing the installed skill`, !result.ok && /原来的技能没有改动/.test(result.error), result);
      eq(`${label}: the original SKILL.md remains byte-for-byte`, fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), old);
      eq(`${label}: companion files remain`, fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'old companion');
      const listed = skills.list().skills.find((entry) => entry.folder === 'demo');
      expect(`${label}: the valid original keeps its disabled state`, !!listed && !listed.error && !listed.enabled, listed);
      eq(`${label}: failed staging is removed`, fs.readdirSync(path.dirname(dest)).filter((name) => name.startsWith('.importing-') || name.startsWith('.replaced-')).length, 0);
    }
    write(path.join(src, 'SKILL.md'), valid('replacement body'));
    write(path.join(src, 'new.txt'), 'new companion');
    const picked = await skills.importSkill(null);
    const result = skills.confirmImport(picked.token);
    const updated = skills.list().skills.find((entry) => entry.folder === 'demo');
    expect('a valid replacement succeeds and is offered to agents', result.ok && updated.enabled && !updated.error && updated.body === 'replacement body', result);
    eq('the valid replacement includes its companion file', fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'new companion');

    selected = path.join(base, 'new-invalid');
    write(path.join(selected, 'SKILL.md'), 'invalid first import');
    const fresh = await skills.importSkill(null);
    expect('an invalid first import is rejected too', !fresh.ok && !!fresh.error, fresh);
    eq('an invalid first import leaves no installed directory', fs.existsSync(path.join(profile, 'skills', 'new-invalid')), false);
  } finally {
    rm(base);
  }
};
