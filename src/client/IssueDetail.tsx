/**
 * One issue's detail: the fields the list already carries, plus the body and the
 * typed links, which need their own reads.
 *
 * The body is the one thing `list --json` does not include, so it arrives
 * separately and carries its own loading/failure state.
 */
import type { ReactElement } from 'react';

import type { IssueItem, MintBodyPayload } from '../records.js';
import { StateNotice } from './StateNotice.js';
import type { CopyTranslate } from './copy.js';
import { describeLink, priorityLabel, statusTone } from './model.js';
import type { LoadState } from './model.js';
import { BODY, BUTTON, META, NOTE, PROSE, TOOLBAR, pill } from './styles.js';

export interface IssueDetailProps {
  copy: CopyTranslate;
  item: IssueItem;
  /** The body read, `undefined` before it starts. */
  body: LoadState<MintBodyPayload> | undefined;
  onBack: () => void;
}

/**
 * Render the detail.
 *
 * @param props - the issue, its body state, and the way back to the list.
 */
export function IssueDetail({ copy, item, body, onBack }: IssueDetailProps): ReactElement {
  const links = item.links
    .map((link) => describeLink(link))
    .filter((line): line is NonNullable<typeof line> => line !== undefined);

  return (
    <>
      <div style={TOOLBAR}>
        <button type="button" style={BUTTON} onClick={onBack}>
          {copy('detail.back')}
        </button>
      </div>
      <div style={BODY}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {`#${String(item.id)} ${item.title}`}
        </div>
        <div style={{ ...META, marginTop: 6 }}>
          <span style={pill(statusTone(item.status))}>{item.status}</span>
          <span>{`${copy('field.kind')} ${item.kind}`}</span>
          <span>{`${copy('field.priority')} ${priorityLabel(item.priority)}`}</span>
          <span>
            {item.plan_id === null ? copy('detail.standalone') : `#${String(item.plan_id)}`}
          </span>
        </div>
        {item.labels.length > 0 && (
          <div style={{ ...META, marginTop: 4 }}>
            <span>{`${copy('field.labels')} ${item.labels.join(' · ')}`}</span>
          </div>
        )}
        {links.length > 0 && (
          <div style={{ ...META, marginTop: 4 }}>
            {links.map((link, index) => (
              <span key={`${link.rel}-${String(index)}`}>
                {`${link.labelKey === undefined ? link.rel : copy(link.labelKey)} ${link.target}`.trim()}
              </span>
            ))}
          </div>
        )}
        <div style={{ ...META, marginTop: 4 }}>
          <span>{`${copy('field.created')} ${item.created_at}`}</span>
          <span>{`${copy('field.updated')} ${item.updated_at}`}</span>
        </div>

        <div style={{ ...NOTE, marginTop: 12 }}>{copy('detail.body')}</div>
        {body === undefined || body.status === 'loading' ? (
          <p style={NOTE}>{copy('state.loading')}</p>
        ) : body.status === 'failed' ? (
          <StateNotice copy={copy} state="failed" message={body.message} stderr={body.stderr} />
        ) : (
          <>
            <p style={PROSE}>{body.value.body}</p>
            {body.value.truncated && <p style={NOTE}>{copy('panel.truncated')}</p>}
          </>
        )}
      </div>
    </>
  );
}
