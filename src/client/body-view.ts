/**
 * 正文区的纯逻辑：两种呈现方式，以及各自要的词条。
 *
 * 模式的顺序就是切换控件的分段顺序，`preview` 在先是「默认预览」的唯一落点；预览里的围栏
 * 代码块与代码模式共用同一组复制词条，故两处文案不会各写一份而漂移。
 *
 * 文件名刻意不叫 `body.ts`：它与同目录的 `Body.tsx` 只差大小写，而客户端 bundle 的 esbuild
 * 解析 `./Body.js` 时会被这组同名撞上并直接报错（见 notes/client-face.md 的已知坑）。
 */
import type { MarkdownLabels, SegmentedControlOption } from '@deepseek-ai/dsh-client-ui-primitives';

import type { CopyTranslate } from './copy.js';

/** 正文的两种呈现方式：渲染后的预览，或逐字原文的高亮代码块。 */
export type BodyMode = 'preview' | 'code';

/** 打开详情先给预览；代码模式是同一片区域的第二模式。 */
export const DEFAULT_BODY_MODE: BodyMode = 'preview';

/** 切换控件的分段：顺序即显示顺序。 */
export function bodyModeOptions(copy: CopyTranslate): readonly SegmentedControlOption<BodyMode>[] {
  return [
    { value: 'preview', label: copy('body.mode.preview') },
    { value: 'code', label: copy('body.mode.code') },
  ];
}

/** 渲染预览所需的 chrome：每个围栏的复制按钮与脚注小节的标题。 */
export function bodyLabels(copy: CopyTranslate): MarkdownLabels {
  return {
    code: { copyLabel: copy('body.copy'), copiedLabel: copy('body.copied') },
    footnotes: copy('body.footnotes'),
  };
}
