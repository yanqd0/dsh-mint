/**
 * issue / plan / milestone 的正文：当前只把 mint 存的 markdown 原文放进高亮的
 * `markdown` 代码块——便于与 CLI 输出逐字对照，也无需 sanitize 方案；后续版本把
 * 渲染预览作为同一组件的第二种模式，复用同一条正文串与同一个 copy 座位。
 */
import type { ReactElement } from 'react';

import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives';

import type { CopyTranslate } from './copy.js';
import { hasBody } from './model.js';
import { NOTE } from './styles.js';

export const BODY_LANGUAGE = 'markdown';

export interface BodyViewProps {
  copy: CopyTranslate;
  body: string | null;
}

export function BodyView({ copy, body }: BodyViewProps): ReactElement {
  if (!hasBody(body)) return <p style={NOTE}>{copy('detail.noBody')}</p>;
  return (
    <CodeBlock
      code={body}
      lang={BODY_LANGUAGE}
      showHeader
      copyLabel={copy('body.copy')}
      copiedLabel={copy('body.copied')}
    />
  );
}
