import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { srcPath } from '../../helpers/repo.js';
import { DEFAULT_BODY_MODE, bodyLabels, bodyModeOptions } from '../../../src/client/body-view.js';
import { createTranslator } from '../../../src/client/copy.js';

/** 记账式译者：断言每个模式与词条到底问了哪个 key。 */
const marking = createTranslator((key) => `t:${key}`);

describe('body modes', () => {
  // 分段顺序即显示顺序，`preview` 在首 = 打开详情先看到渲染结果（「预览为默认」的落点）。
  it('puts the preview segment first and keys both from the copy seat', () => {
    expect(bodyModeOptions(marking)).toEqual([
      { value: 'preview', label: 't:body.mode.preview' },
      { value: 'code', label: 't:body.mode.code' },
    ]);
  });

  it('opens on the preview mode', () => {
    expect(DEFAULT_BODY_MODE).toBe('preview');
  });
});

describe('body markdown labels', () => {
  // 预览里的围栏代码块与代码模式共用同一组复制词条，两处文案因此不会各写一份而漂移。
  it('reuses the code block copy labels and names the footnote section', () => {
    expect(bodyLabels(marking)).toEqual({
      code: { copyLabel: 't:body.copy', copiedLabel: 't:body.copied' },
      footnotes: 't:body.footnotes',
    });
  });
});

// 组件在 Node 里渲染不了（本仓没有 react-dom/jsdom），接线只能读源码——先例见 dag-model.test.ts。
describe('body view wiring', () => {
  it('keeps both modes wired to the shared copy seat', () => {
    const source = readFileSync(srcPath('client', 'Body.tsx'), 'utf8');
    for (const literal of [
      'DEFAULT_BODY_MODE',
      'bodyModeOptions',
      'bodyLabels',
      'SegmentedControl',
      'MarkdownText',
      'CodeBlock',
    ]) {
      expect(source, `Body.tsx 丢了 ${literal} 的接线`).toContain(literal);
    }
  });
});
