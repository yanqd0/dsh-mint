/**
 * The body of an issue, plan, or milestone.
 *
 * These bodies are markdown, and 0.2.0 deliberately does not render them: it
 * shows the source in a highlighted `markdown` code block, which is easier to
 * compare against the CLI output and needs no sanitizing story. 0.3.0 adds the
 * rendered preview as a second mode of this same component (issue #87), over the
 * same body string and the same copy seat.
 */
import type { ReactElement } from 'react';

import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives';

import type { CopyTranslate } from './copy.js';
import { hasBody } from './model.js';
import { NOTE } from './styles.js';

/** The grammar the bodies are written in; highlighting the source is the point. */
export const BODY_LANGUAGE = 'markdown';

export interface BodyViewProps {
  copy: CopyTranslate;
  /** The record's source, exactly as mint stores it. */
  body: string;
}

/**
 * Render one body.
 *
 * @param props - the copy seat and the record's markdown source.
 */
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
