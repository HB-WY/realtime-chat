// client/src/components/common/FileTypeIcon.jsx
//
// 文件类型图标：传文件名（可带 mime 兜底），自动选图形并着色。
//
//   · 类型表在 `utils/fileTypes.js`（内置 11 类 + 开发者自定义），本文件**只负责画**
//   · 开发者给某个类型配了 `cover`（config.yaml → files.types[].cover）时，
//     直接渲染那张封面图；否则用内置的 SVG 图形
//
// 品牌图形（Word / Excel / PowerPoint / Acrobat / 7-Zip）的路径数据取自
// simple-icons（CC0-1.0，https://simpleicons.org），经 jsDelivr 取单个 SVG 后把
// `<path d>` 内联：零图标库依赖、不在运行期请求网络。
// 来源 slug：microsoftword / microsoftexcel / microsoftpowerpoint /
//           adobeacrobatreader / 7zip
// 其余类型（文本/代码/音频/视频/图片/兜底）为自绘通用图形，
// 统一 24×24 viewBox、fill=currentColor，与项目既有的 Icon.jsx 风格一致。
//
import { useSyncExternalStore } from 'react';
import { fileKind, subscribeFileTypes, fileTypesVersion } from '../../utils/fileTypes';
import { resolveMediaUrl } from '../../utils/media';

// 品牌 logo 的 path d（来自 simple-icons）。fill 由组件统一给 currentColor。
const BRAND_PATHS = {
  word: 'M23.004 1.5q.41 0 .703.293t.293.703v19.008q0 .41-.293.703t-.703.293H6.996q-.41 0-.703-.293T6 21.504V18H.996q-.41 0-.703-.293T0 17.004V6.996q0-.41.293-.703T.996 6H6V2.496q0-.41.293-.703t.703-.293zM6.035 11.203l1.442 4.735h1.64l1.57-7.876H9.036l-.937 4.653-1.325-4.5H5.38l-1.406 4.523-.938-4.675H1.312l1.57 7.874h1.641zM22.5 21v-3h-15v3zm0-4.5v-3.75H12v3.75zm0-5.25V7.5H12v3.75zm0-5.25V3h-15v3Z',
  excel: 'M23 1.5q.41 0 .7.3.3.29.3.7v19q0 .41-.3.7-.29.3-.7.3H7q-.41 0-.7-.3-.3-.29-.3-.7V18H1q-.41 0-.7-.3-.3-.29-.3-.7V7q0-.41.3-.7Q.58 6 1 6h5V2.5q0-.41.3-.7.29-.3.7-.3zM6 13.28l1.42 2.66h2.14l-2.38-3.87 2.34-3.8H7.46l-1.3 2.4-.05.08-.04.09-.64-1.28-.66-1.29H2.59l2.27 3.82-2.48 3.85h2.16zM14.25 21v-3H7.5v3zm0-4.5v-3.75H12v3.75zm0-5.25V7.5H12v3.75zm0-5.25V3H7.5v3zm8.25 15v-3h-6.75v3zm0-4.5v-3.75h-6.75v3.75zm0-5.25V7.5h-6.75v3.75zm0-5.25V3h-6.75v3Z',
  ppt: 'M13.5 1.5q1.453 0 2.795.375 1.342.375 2.508 1.06 1.166.686 2.12 1.641.956.955 1.641 2.121.686 1.166 1.061 2.508Q24 10.547 24 12q0 1.453-.375 2.795-.375 1.342-1.06 2.508-.686 1.166-1.641 2.12-.955.956-2.121 1.641-1.166.686-2.508 1.061-1.342.375-2.795.375-1.29 0-2.52-.305-1.23-.304-2.337-.884-1.108-.58-2.063-1.418-.955-.838-1.693-1.893H.997q-.411 0-.704-.293T0 17.004V6.996q0-.41.293-.703T.996 6h3.89q.739-1.055 1.694-1.893.955-.837 2.063-1.418 1.107-.58 2.337-.884Q12.21 1.5 13.5 1.5zm.75 1.535v8.215h8.215q-.14-1.64-.826-3.076-.686-1.436-1.782-2.531-1.095-1.096-2.537-1.782-1.441-.685-3.07-.826zm-5.262 7.57q0-.68-.228-1.166-.229-.486-.627-.79-.399-.305-.938-.446-.539-.14-1.172-.14H2.848v7.863h1.84v-2.742H5.93q.574 0 1.119-.17t.978-.493q.434-.322.698-.802.263-.48.263-1.114zM13.5 21q1.172 0 2.262-.287t2.056-.82q.967-.534 1.776-1.278.808-.744 1.418-1.664.61-.92.984-1.986.375-1.067.469-2.227h-9.703V3.035q-1.735.14-3.27.908T6.797 6h4.207q.41 0 .703.293t.293.703v10.008q0 .41-.293.703t-.703.293H6.797q.644.715 1.412 1.271.768.557 1.623.944.855.387 1.781.586Q12.54 21 13.5 21zM5.812 9.598q.575 0 .915.228.34.229.34.838 0 .27-.124.44-.123.17-.31.275-.188.105-.422.146-.234.041-.445.041H4.687V9.598Z',
  pdf: 'M23.63 15.3c-.71-.745-2.166-1.17-4.224-1.17-1.1 0-2.377.106-3.761.354a19.443 19.443 0 0 1-2.307-2.661c-.532-.71-.994-1.49-1.42-2.236.817-2.484 1.207-4.507 1.207-5.962 0-1.632-.603-3.336-2.342-3.336-.532 0-1.065.32-1.349.781-.78 1.384-.425 4.4.923 7.381a60.277 60.277 0 0 1-1.703 4.507c-.568 1.349-1.207 2.733-1.917 4.01C2.834 18.53.314 20.34.03 21.758c-.106.533.071 1.03.462 1.42.142.107.639.533 1.49.533 2.59 0 5.323-4.188 6.707-6.707 1.065-.355 2.13-.71 3.194-.994a34.963 34.963 0 0 1 3.407-.745c2.732 2.448 5.145 2.839 6.352 2.839 1.49 0 2.023-.604 2.2-1.1.32-.64.106-1.349-.213-1.704zm-1.42 1.03c-.107.532-.64.887-1.384.887-.213 0-.39-.036-.604-.071-1.348-.32-2.626-.994-3.903-2.059a17.717 17.717 0 0 1 2.98-.248c.746 0 1.385.035 1.81.142.497.106 1.278.426 1.1 1.348zm-7.524-1.668a38.01 38.01 0 0 0-2.945.674 39.68 39.68 0 0 0-2.52.745 40.05 40.05 0 0 0 1.207-2.555c.426-.994.78-2.023 1.136-2.981.354.603.745 1.207 1.135 1.739a50.127 50.127 0 0 0 1.987 2.378zM10.038 1.46a.768.768 0 0 1 .674-.425c.745 0 .887.851.887 1.526 0 1.135-.355 2.874-.958 4.861-1.03-2.768-1.1-5.074-.603-5.962zM6.134 17.997c-1.81 2.981-3.549 4.826-4.613 4.826a.872.872 0 0 1-.532-.177c-.213-.213-.32-.461-.249-.745.213-1.065 2.271-2.555 5.394-3.904Z',
  archive:
    'M0 18.858h24V8.181H10.717V5.142H0ZM2.021 7.271h6.657v1.994c-1.74 2.09-2.84 4.502-2.948 7.404H3.477c.09-2.501.353-4.954 2.283-6.994l.033-.033H2.021Zm8.45 1.253h13.215v10.143H10.47Zm6.01 1.213v6.871h1.482v-6.87Zm2.755.043v6.912h1.616v-2.42h1.029c.43-.001.754-.29.969-.716.427-.848.429-2.257-.024-3.092-.227-.419-.571-.697-1.033-.684zm-7.924.002v1.596h2.217l-2.304 3.736v1.54h4.287V15.1h-2.698l2.786-3.909v-1.41Zm9.452 1.512h.595c.164-.006.287.081.371.217.17.273.172.736.004.99a.364.364 0 0 1-.373.176l-.55.047z'
};

// 自绘图形统一画在 22×22 坐标系里，再用外层 <g> 缩放到 24×24
const PAPER = 'M5 1h9l5 5v12.8a2.2 2.2 0 0 1-2.2 2.2H5a2.2 2.2 0 0 1-2.2-2.2V3.2A2.2 2.2 0 0 1 5 1Z';

const CUSTOM_GLYPHS = {
  text: (
    <>
      <path fill="currentColor" d={PAPER} />
      <path fill="#fff" d="M6 8.6h10M6 11.4h10M6 14.2h10M6 17h6.5" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  code: (
    <>
      <path fill="currentColor" d={PAPER} />
      <path
        d="M8.6 8.8 5.6 12.1l3 3.3M13.4 8.8l3 3.3-3 3.3M12.4 7.4l-2.8 9.4"
        fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </>
  ),
  audio: (
    <>
      <path fill="currentColor" d={PAPER} />
      <path fill="#fff" d="M12.6 6.2q1.5.5 2.7 1.2.6.4.6 1l-.1 4.9a1.9 1.9 0 1 1-1.4-1.8v-3.3l-.3-.1q-.5-.3-1.3-.6h-.2Z" />
      <circle fill="#fff" cx="9.9" cy="14.6" r="2.2" />
    </>
  ),
  video: (
    <>
      <path fill="currentColor" d={PAPER} />
      <path fill="#fff" d="M8.8 8 16.4 12.1 8.8 16.2Z" />
    </>
  ),
  image: (
    <>
      <path fill="currentColor" d={PAPER} />
      <rect x="5.2" y="6.2" width="11.6" height="10" rx="1.2" fill="none" stroke="#fff" strokeWidth="1.3" />
      <circle fill="#fff" cx="8.6" cy="9.6" r="1.1" />
      <path fill="#fff" d="m5.4 16.2 4.3-4.5 3 3 2.2-2.3 2.1 2.3v1.6H5.4Z" />
    </>
  ),
  file: (
    <>
      <path fill="currentColor" d={PAPER} />
      <path fill="#fff" d="M14.4 1.6 19 6.2h-4.6Z" />
      <path
        d="M8.2 8.4h2.2a3.7 3.7 0 0 1 0 7.4H8.2Z"
        fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </>
  )
};

const ICON_BY_KIND = {
  word: <path fill="currentColor" d={BRAND_PATHS.word} />,
  excel: <path fill="currentColor" d={BRAND_PATHS.excel} />,
  ppt: <path fill="currentColor" d={BRAND_PATHS.ppt} />,
  pdf: <path fill="currentColor" d={BRAND_PATHS.pdf} />,
  archive: <path fill="currentColor" d={BRAND_PATHS.archive} />,
  text: CUSTOM_GLYPHS.text,
  code: CUSTOM_GLYPHS.code,
  audio: CUSTOM_GLYPHS.audio,
  video: CUSTOM_GLYPHS.video,
  image: CUSTOM_GLYPHS.image,
  file: CUSTOM_GLYPHS.file
};

/**
 * 文件类型图标：传文件名（可带 mime 兜底），自动选图形并着色。
 * @param {{ name?: string, mime?: string, size?: number, className?: string, style?: object }} props
 */
export default function FileTypeIcon({ name, mime, size = 40, className, style }) {
  // 自定义类型是登录后异步拉回来的；订阅一下，拉到之后已渲染的图标会自动重画
  useSyncExternalStore(subscribeFileTypes, fileTypesVersion, fileTypesVersion);
  const kind = fileKind(name, mime);

  // 开发者给这个类型配了封面图 → 直接用它
  if (kind.cover) {
    return (
      <img
        className={className}
        // width/height 同时给「属性」和「样式」：属性让浏览器提前占位（避免布局抖动），
        // 样式负责实际缩放与保持比例
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain', ...style }}
        src={resolveMediaUrl(kind.cover)}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }

  const glyph = ICON_BY_KIND[kind.key] || ICON_BY_KIND.file;
  return (
    <svg
      className={className}
      style={{ color: kind.color, ...style }}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {/* 颜色：外层 svg 用 style 设 color，图形统一 fill="currentColor" */}
      <g transform="translate(1 1) scale(0.916667)">{glyph}</g>
    </svg>
  );
}
