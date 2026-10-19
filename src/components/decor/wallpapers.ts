/* Character wallpapers for the background layer. Both are fan art found on wallhaven and credited
   to their pixiv authors; they ship for local, personal use only (see README「壁纸」). */
import type { VisualMode } from '../../lib/types';

export interface WallpaperDef {
  id: 'firefly' | 'sam';
  mode: VisualMode;
  title: string;
  /** Encoded widths available in public/wallpapers as <id>-<w>.avif / .webp. */
  widths: number[];
  /** object-position: keeps her face in view when the screen ratio crops the image. */
  focus: string;
  /** 48×27 blurred preview shown while the full image loads. */
  lqip: string;
  credit: { label: string; url: string; via: string };
}

export const WALLPAPERS: WallpaperDef[] = [
  {
    id: 'firefly', mode: 'firefly', title: '星空下飞行的流萤',
    widths: [1600, 2560, 3840], focus: '38% 34%',
    lqip: 'data:image/webp;base64,UklGRu4AAABXRUJQVlA4IOIAAADQBwCdASowABsAPtFSo0uoJKMhsBVdUQAaCWQAnTlBVH5sDshHGtrIB7Mp7LG4I/9K+bUtsLFEoWN9sfBovu86RyaSzkOwAAD++nGIRtEtPXywzMsNyogAD6GInSoi3yA36veTcUwUG4Ismc7cUSO2EmDYWDKlie6jaoFJHGWFzp0loROqRa5TZ6cppLDAMKSzIlpqcgolM0VS2Gp0yaZ8f1HlHlEAyrSI3110GXQVt99pvlpN2wy5eUEkcyjxC4wWiehov8lr9jg1jSYKCQJUaUKfPllHWj9pJZT6aNJnLgAA',
    credit: { label: 'pixiv 作品 119791514', url: 'https://www.pixiv.net/artworks/119791514', via: 'https://wallhaven.cc/w/yq77og' },
  },
  {
    id: 'sam', mode: 'sam', title: '青焰中的流萤',
    widths: [1600, 2560, 3840], focus: '64% 32%',
    lqip: 'data:image/webp;base64,UklGRiQBAABXRUJQVlA4IBgBAADwCACdASowABsAPs1SpEunpKOhqq348BmJZgCsMoSGd9DMm+DNZNch7h2lZ60sVcy0YayTuqJvm4KqVrqG6KLdh/pkZhG4mEfq/O7v1nwwAAD+3L3/rC2b/3WvFTXn/vSBfaCf24Dpg5FGztnNjMh81by+zJY5XLdyWjyt0kzmIA6LiWNoUnkcx2+/bJEsPQAobZepGWp7t0xc9yLu97rT2Z4xqp7Nvb+ZlNtlBxATEZmAw5RFGlNFqXMgptcJYLqEgyKPYtGuebkXG92/DsoiGqWzf/d3PKPXG2MSm+QAo/EuDOBwhZZZmCco1lywccNoE4vj6x7sxy3KEuQhA5/shjAZlQSCnTV280f0ZNoDl13lWOP3JYAA',
    credit: { label: 'pixiv 作品 120107524', url: 'https://www.pixiv.net/artworks/120107524', via: 'https://wallhaven.cc/w/vql63m' },
  },
];

export const wallpaperFor = (mode: VisualMode) => WALLPAPERS.find((w) => w.mode === mode) ?? WALLPAPERS[0];
