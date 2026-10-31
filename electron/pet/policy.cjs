// What the 桌宠 may do with the program in front (docs/PET.md §4). No Electron here, so
// scripts/pet-check.ts can drive it; the only I/O is a cached directory listing (see antiCheatPath).
// classify() turns what the sense helper reports into a FocusApp.
//
// Priority: 永远不看 > 不要看 > anti-cheat (built-in list, or markers in the game's folder; chat only)
// > 可以看 > built-in games. Only those last two give 'watch': a program that merely looks like a game
// (borderless full screen) is NOT one. It stays a non-game ('chat-only', she only knows its name) until
// the user says so with the right-click item 「当作游戏」 (gameAllow).
//
// raw.path (the program's full image path) is read here and nowhere else: classify() drops it, so it
// never reaches the page or a model.

const fs = require('node:fs');
const nodePath = require('node:path');

/** exe → display name, for games she is allowed to look at. */
const GAMES = new Map(Object.entries({
  'starrail.exe': '崩坏：星穹铁道',
  'yuanshen.exe': '原神',
  'genshinimpact.exe': '原神',
  'zenlesszonezero.exe': '绝区零',
  'bh3.exe': '崩坏3',
  'sekiro.exe': '只狼',
  'darksoulsremastered.exe': '黑暗之魂 重制版',
  'b1-win64-shipping.exe': '黑神话：悟空',
  'cyberpunk2077.exe': '赛博朋克 2077',
  'witcher3.exe': '巫师3',
  'rdr2.exe': '荒野大镖客：救赎2',
  'bg3.exe': '博德之门3',
  'bg3_dx11.exe': '博德之门3',
  'palworld-win64-shipping.exe': '幻兽帕鲁',
  'monsterhunterwilds.exe': '怪物猎人：荒野',
  'monsterhunterworld.exe': '怪物猎人：世界',
  'nierautomata.exe': '尼尔：机械纪元',
  'p5r.exe': '女神异闻录5 皇家版',
  'ffxiv_dx11.exe': '最终幻想14',
  'ffxiv.exe': '最终幻想14',
  'wow.exe': '魔兽世界',
  'wowclassic.exe': '魔兽世界 怀旧服',
  'diablo iv.exe': '暗黑破坏神4',
  'd2r.exe': '暗黑破坏神2 重制版',
  'minecraft.windows.exe': 'Minecraft',
  'terraria.exe': '泰拉瑞亚',
  'stardewvalley.exe': '星露谷物语',
  'hollow_knight.exe': '空洞骑士',
  'hollowknight.exe': '空洞骑士',
  'hollowknightsilksong.exe': '空洞骑士：丝之歌',
  'celeste.exe': '蔚蓝',
  'hades.exe': '哈迪斯',
  'hades2.exe': '哈迪斯 2',
  'balatro.exe': '小丑牌',
  'slaythespire.exe': '杀戮尖塔',
  'vampiresurvivors.exe': '吸血鬼幸存者',
  're2.exe': '生化危机2',
  're4.exe': '生化危机4',
  're8.exe': '生化危机：村庄',
  'sifu.exe': '师父',
  'stray-win64-shipping.exe': '迷失',
  'lethalcompany.exe': '致命公司',
  'valheim.exe': '英灵神殿',
  'subnautica.exe': '深海迷航',
  'factorio.exe': '异星工厂',
  'rimworldwin64.exe': '环世界',
  'hoi4.exe': '钢铁雄心4',
  'eu4.exe': '欧陆风云4',
  'ck3.exe': '十字军之王3',
  'stellaris.exe': '群星',
  'civilizationvi.exe': '文明6',
  'civilizationvii.exe': '文明7',
  'osu!.exe': 'osu!',
  'osu!lazer.exe': 'osu!',
  'smt5v-win64-shipping.exe': '真・女神转生V',
  'octopath_traveler2.exe': '八方旅人2',
  'ff7rebirth_.exe': '最终幻想7 重生',
  'phasmophobia.exe': '恐鬼症',
  'cuphead.exe': '茶杯头',
  'undertale.exe': 'Undertale',
  'deltarune.exe': 'Deltarune',
  'raft.exe': 'Raft',
  'satisfactory.exe': '幸福工厂',
}));

/**
 * Games with an anti-cheat (competitive ones, and single-player ones whose online mode is protected):
 * she chats about them but never looks (exe → name). This list is the floor; a game that is not on it
 * is still caught when its folder holds anti-cheat files (antiCheatPath below).
 */
const ANTICHEAT = new Map(Object.entries({
  // EasyAntiCheat
  'eldenring.exe': '艾尔登法环',
  'nightreign.exe': '艾尔登法环：黑夜君临',
  'darksoulsiii.exe': '黑暗之魂3',
  'armoredcore6.exe': '装甲核心6',
  // GameGuard
  'helldivers2.exe': '地狱潜者 2',
  // BattlEye (GTA Online)
  'gta5.exe': '侠盗猎车手5',
  'gtav.exe': '侠盗猎车手5',
  'gta5_enhanced.exe': '侠盗猎车手5',
  // ACE (Wuthering Waves also runs as client-win64-shipping.exe: see AMBIGUOUS)
  'wutheringwaves.exe': '鸣潮',
  'valorant.exe': '无畏契约',
  'valorant-win64-shipping.exe': '无畏契约',
  'cs2.exe': 'CS2',
  'csgo.exe': 'CS:GO',
  'r5apex.exe': 'Apex 英雄',
  'r5apex_dx12.exe': 'Apex 英雄',
  'fortniteclient-win64-shipping.exe': '堡垒之夜',
  'overwatch.exe': '守望先锋',
  'tslgame.exe': 'PUBG',
  'rainbowsix.exe': '彩虹六号：围攻',
  'rainbowsix_vulkan.exe': '彩虹六号：围攻',
  'league of legends.exe': '英雄联盟',
  'leagueoflegends.exe': '英雄联盟',
  'dota2.exe': 'Dota 2',
  'cod.exe': '使命召唤',
  'modernwarfare.exe': '使命召唤',
  'deltaforceclient-win64-shipping.exe': '三角洲行动',
  'marvel-win64-shipping.exe': '漫威争锋',
  'narakabladepoint.exe': '永劫无间',
  'crossfire.exe': '穿越火线',
  'escapefromtarkov.exe': '逃离塔科夫',
  'rustclient.exe': 'Rust',
  'huntgame.exe': 'Hunt: Showdown',
  'discovery.exe': 'THE FINALS',
  'bf2042.exe': '战地 2042',
  'bf6.exe': '战地 6',
  'rocketleague.exe': '火箭联盟',
  'dnf.exe': '地下城与勇士',
  'dwrg.exe': '第五人格',
}));

/** Programs that are full-screen at times without being a game: their folders are not scanned for anti-cheat files. */
const NOT_GAMES = new Set([
  // browsers
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'iexplore.exe',
  '360se.exe', '360chrome.exe', 'qqbrowser.exe', 'sogouexplorer.exe', 'thorium.exe',
  // players and music
  'vlc.exe', 'potplayer.exe', 'potplayermini.exe', 'potplayermini64.exe', 'potplayer64.exe', 'mpv.exe', 'mpc-hc.exe', 'mpc-hc64.exe',
  'wmplayer.exe', 'kmplayer.exe', 'bilibili.exe', 'cloudmusic.exe', 'qqmusic.exe', 'spotify.exe', 'iqiyi.exe', 'qyclient.exe',
  'microsoft.media.player.exe', 'video.ui.exe',
  // documents and mail
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'onenote.exe', 'outlook.exe', 'wps.exe', 'wpp.exe', 'et.exe', 'wpspdf.exe',
  'acrobat.exe', 'acrord32.exe', 'foxitreader.exe', 'sumatrapdf.exe', 'notepad.exe', 'notepad++.exe',
  // remote desktop and virtual machines
  'mstsc.exe', 'vmware.exe', 'vmplayer.exe', 'vmware-vmx.exe', 'virtualbox.exe', 'virtualboxvm.exe', 'teamviewer.exe', 'anydesk.exe',
  'todesk.exe', 'sunloginclient.exe', 'rustdesk.exe', 'parsecd.exe', 'moonlight.exe', 'vmconnect.exe',
  // editors, terminals, the shell
  'code.exe', 'devenv.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'clion64.exe', 'studio64.exe', 'windowsterminal.exe',
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'explorer.exe', 'taskmgr.exe', 'mmc.exe', 'regedit.exe',
  'applicationframehost.exe', 'systemsettings.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
  'lockapp.exe', 'logonui.exe', 'dwm.exe', 'textinputhost.exe', 'snippingtool.exe', 'screenclippinghost.exe',
  // chat and meetings
  'wechat.exe', 'weixin.exe', 'qq.exe', 'qqnt.exe', 'telegram.exe', 'discord.exe', 'slack.exe', 'teams.exe', 'ms-teams.exe', 'zoom.exe',
  'feishu.exe', 'lark.exe', 'dingtalk.exe', 'wemeetapp.exe',
  // creative tools
  'photoshop.exe', 'illustrator.exe', 'premiere pro.exe', 'afterfx.exe', 'blender.exe', 'obs64.exe', 'obs32.exe', 'resolve.exe',
  'clipstudiopaint.exe', 'figma.exe', 'krita.exe',
  // launchers and stores (Big Picture mode is full-screen too)
  'steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'wegame.exe', 'origin.exe', 'eadesktop.exe', 'gog galaxy.exe',
  'galaxyclient.exe', 'ubisoftconnect.exe', 'upc.exe', 'xboxpcapp.exe', 'gamingapp.exe', 'playnite.desktopapp.exe',
  // password managers
  'keepass.exe', '1password.exe', 'bitwarden.exe', 'lastpass.exe', 'dashlane.exe',
  // this app
  'fireflyharness.exe', 'electron.exe',
]);

/**
 * Executables whose file name alone does not say which game it is (Unreal Engine's <Project>-Win64-Shipping.exe):
 * the title or the folder decides. `re` is tested on both; with no path to look at, she assumes the protected game.
 */
const AMBIGUOUS = new Map(Object.entries({
  'client-win64-shipping.exe': { name: '鸣潮', re: /鸣潮|wuthering/i },
}));

const lower = (v) => String(v || '').toLowerCase();
const has = (list, exe) => Array.isArray(list) && list.some((x) => lower(x) === exe);

/* ───────────── anti-cheat found by the game's folder ───────────── */

// File or folder names that only an anti-cheat ships (EasyAntiCheat, BattlEye, GameGuard / nProtect,
// ACE / AntiCheatExpert, Riot Vanguard, XIGNCODE, PunkBuster). Deliberately not miHoYo's own driver:
// 崩坏：星穹铁道 and 原神 stay watchable.
const AC_MARKER = new RegExp([
  '^easyanticheat', '^start_protected_game\\.exe$',
  '^battleye$', '^be(service|client)(_x64)?\\.(exe|dll)$',
  '^gameguard', '^nprotect', '^npgg', '^npgl', '^gamemon',
  '^ace-base', '^ace-setup', '^anticheatexpert',
  '^vgk\\.sys$', '^vgc\\.exe$', '^riot vanguard$',
  '^xigncode', '^x3\\.xem$', '^punkbuster$', '^pbsvc',
].join('|'), 'i');
/** Folders that hold many programs: never scanned, and the walk up from a game stops there. */
const CONTAINERS = new Set(['common', 'steamapps', 'program files', 'program files (x86)', 'programdata', 'windowsapps', 'users', 'appdata', 'local', 'programs', 'games']);
const DIR_TTL_MS = 10 * 60000;
const DIR_CACHE_MAX = 200;
/** folder (lower case) → { at, hit } */
const dirCache = new Map();

function listDirDefault(dir) { return fs.readdirSync(dir); }

function dirHasAntiCheat(dir, listDir) {
  const key = dir.toLowerCase();
  const now = Date.now();
  const c = dirCache.get(key);
  if (c && now - c.at < DIR_TTL_MS) return c.hit;
  let hit = false;
  try { hit = listDir(dir).some((n) => AC_MARKER.test(String(n))); } catch { /* gone, or no access: no marker */ }
  if (dirCache.size >= DIR_CACHE_MAX) dirCache.clear();
  dirCache.set(key, { at: now, hit });
  return hit;
}

/**
 * Does the game's folder, or one of up to three above it (Unreal keeps EasyAntiCheat next to Engine, three
 * levels above the exe), carry anti-cheat files? Folder listings are cached for ten minutes.
 */
function antiCheatPath(gamePath, listDir) {
  const p = String(gamePath || '');
  if (!/^[a-z]:\\/i.test(p) || /^[a-z]:\\windows\\/i.test(p)) return false;
  let dir = nodePath.win32.dirname(p);
  for (let i = 0; i < 4; i++) {
    const name = nodePath.win32.basename(dir).toLowerCase();
    if (!name || CONTAINERS.has(name)) break; // drive root, or a folder that holds many programs
    if (dirHasAntiCheat(dir, listDir)) return true;
    dir = nodePath.win32.dirname(dir);
  }
  return false;
}

/* ───────────── classify ───────────── */

/** Minecraft runs inside javaw.exe: only the title gives it away. */
function titleGame(exe, title) {
  if ((exe === 'javaw.exe' || exe === 'java.exe') && /^minecraft\b/i.test(title)) return 'Minecraft';
  return undefined;
}

const exeBase = (exe) => exe.replace(/\.exe$/i, '');

/** A readable name for a game the user allowed that is not in the built-in list: the window title, else the exe name. */
function nameFrom(exe, title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t && t.length <= 40) return t;
  return exeBase(exe);
}

/** Built-in knowledge about a program: { name, anti? } or undefined. */
function known(exe, title, gamePath) {
  const amb = AMBIGUOUS.get(exe);
  if (amb) {
    if (amb.re.test(title) || amb.re.test(gamePath)) return { name: amb.name, anti: true };
    // Can't tell which game it is: stay on the safe side. With a path that says otherwise it is some other program.
    return gamePath ? undefined : { name: amb.name, anti: true };
  }
  if (ANTICHEAT.has(exe)) return { name: ANTICHEAT.get(exe), anti: true };
  const t = titleGame(exe, title);
  if (t) return { name: t };
  if (GAMES.has(exe)) return { name: GAMES.get(exe) };
  return undefined;
}

/**
 * raw = { exe, title, pid, hwnd, fullscreen: 'no'|'borderless'|'exclusive', rect, path? } from sense.cjs
 * (path = full image path of the program; used here only, never copied into the result).
 * lists = { neverWatch, gameAllow, gameDeny } (lower-case exe names).
 * env = { listDir(dir) → names } replaces the folder listing (tests).
 * Returns the FocusApp of src/pet/contracts.ts.
 */
function classify(raw, lists = {}, env = {}) {
  const exe = lower(raw && raw.exe);
  const title = String((raw && raw.title) || '');
  const gamePath = typeof (raw && raw.path) === 'string' ? raw.path.slice(0, 520) : '';
  const fullscreen = raw && (raw.fullscreen === 'borderless' || raw.fullscreen === 'exclusive') ? raw.fullscreen : 'no';
  const base = {
    exe,
    title,
    pid: Number.isFinite(Number(raw && raw.pid)) ? Math.round(Number(raw.pid)) : 0,
    hwnd: String((raw && raw.hwnd) || '0'),
    fullscreen,
  };
  // Never: she does not even keep the window title.
  if (has(lists.neverWatch, exe)) return { ...base, title: '', isGame: false, policy: 'never' };

  const info = known(exe, title, gamePath);
  const allowed = has(lists.gameAllow, exe);
  const denied = has(lists.gameDeny, exe);
  // An anti-cheat in the game's folder beats the user's 「可以看」, like the built-in list does. A full-screen
  // window alone proves nothing and is not looked at here.
  const guarded = !!(info && info.anti) || (!!exe && !NOT_GAMES.has(exe) && antiCheatPath(gamePath, env.listDir || listDirDefault));
  const isGame = !!info || allowed || guarded;
  // The window title names a game only when the user said it is one; it never names a guess.
  const game = !isGame ? undefined : info ? info.name : allowed && !guarded ? nameFrom(exe, title) : exeBase(exe);
  const watch = isGame && !denied && !guarded;
  // antiCheat: her window is hidden while it is in front (index.cjs), so the brain does not greet it either.
  return { ...base, isGame, ...(game ? { game } : {}), policy: watch ? 'watch' : 'chat-only', ...(guarded ? { antiCheat: true } : {}) };
}

/**
 * Is this a game with an anti-cheat (the built-in list, or markers in its folder)? The user's lists do not matter:
 * index.cjs hides her window over such a game. Same inputs as classify().
 */
function isAntiCheat(raw, env = {}) {
  const c = classify(raw, {}, env);
  return c.isGame && c.policy === 'chat-only';
}

module.exports = { classify, isAntiCheat, GAMES, ANTICHEAT, NOT_GAMES };
