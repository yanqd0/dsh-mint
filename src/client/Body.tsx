/**
 * issue / plan / milestone 的正文区：默认把 mint 存的 markdown 渲染成预览，原文高亮的
 * `markdown` 代码块是同一片区域的第二模式。两种模式共用一条正文串、一组复制词条与一个切换
 * 控件，所以「读渲染结果」与「与 CLI 逐字对账」不会长成两份实现。
 */
import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import { CodeBlock, MarkdownText, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';

import { DEFAULT_BODY_MODE, bodyLabels, bodyModeOptions } from './body-view.js';
import type { BodyMode } from './body-view.js';
import type { CopyTranslate } from './copy.js';
import { hasBody } from './model.js';
import { BODY_HEADER, NOTE } from './styles.js';

export const BODY_LANGUAGE = 'markdown';

export interface BodyViewProps {
  copy: CopyTranslate;
  body: string | null;
}

export function BodyView({ copy, body }: BodyViewProps): ReactElement {
  const [mode, setMode] = useState<BodyMode>(DEFAULT_BODY_MODE);
  // 切换控件按基 id 生成 tab 与它认领的面板 id；同一页面可以挂多个会话的 mint tab，故必须唯一。
  const id = useId();
  // 词条每次渲染现取：`copy` 座位跨语言切换是稳定引用，memo 它会把预览冻结在旧语言。
  const content = !hasBody(body) ? (
    <p style={NOTE}>{copy('detail.noBody')}</p>
  ) : mode === 'preview' ? (
    <div id={`${id}-preview-panel`} role="tabpanel" aria-labelledby={`${id}-preview`}>
      <MarkdownText text={body} labels={bodyLabels(copy)} />
    </div>
  ) : (
    <div id={`${id}-code-panel`} role="tabpanel" aria-labelledby={`${id}-code`}>
      <CodeBlock
        code={body}
        lang={BODY_LANGUAGE}
        showHeader
        copyLabel={copy('body.copy')}
        copiedLabel={copy('body.copied')}
      />
    </div>
  );

  return (
    <>
      <div style={BODY_HEADER}>
        <span style={NOTE}>{copy('detail.body')}</span>
        {hasBody(body) && (
          <SegmentedControl
            id={id}
            value={mode}
            options={bodyModeOptions(copy)}
            onChange={(next) => {
              setMode(next);
            }}
            label={copy('body.mode.label')}
          />
        )}
      </div>
      {content}
    </>
  );
}
