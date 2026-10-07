/**
 * One issue in full: identity, placement, labels, links, and the body.
 *
 * The item arrives from `show --json`, so this view renders exactly what the
 * route validated — no fields are carried over from the list row.
 */
import type { ReactElement } from 'react';

import type { IssueDetail as IssueDetailRecord, MintMetaPayload } from '../shared/records.js';
import { BodyView } from './Body.js';
import { LabelBadges, PlacementChips } from './Rows.js';
import type { CopyTranslate } from './copy.js';
import { describeLink, detailPlacement, priorityLabel, statusTone } from './model.js';
import { BODY, BUTTON, META, NOTE, TOOLBAR, pill } from './styles.js';

export interface IssueDetailProps {
  copy: CopyTranslate;
  item: IssueDetailRecord;
  /** The lookup tables; the milestone's version label lives in them. */
  meta: MintMetaPayload | undefined;
  /** True when the route cut the body at its byte budget. */
  truncated: boolean;
  onBack: () => void;
}

/**
 * Render the detail.
 *
 * @param props - the issue, whether its body was cut, and the way back.
 */
export function IssueDetail({ copy, item, meta, truncated, onBack }: IssueDetailProps): ReactElement {
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
        <div style={{ fontSize: 13, fontWeight: 600 }}>{`#${String(item.id)} ${item.title}`}</div>
        <div style={{ ...META, marginTop: 6 }}>
          <span style={pill(statusTone(item.status))}>{item.status}</span>
          <span>{copy('detail.kind', { kind: item.kind })}</span>
          <span>{copy('detail.priority', { priority: priorityLabel(item.priority) })}</span>
          {item.plan_id === null && item.milestone_id === null && (
            <span>{copy('detail.standalone')}</span>
          )}
          <PlacementChips copy={copy} placement={detailPlacement(item, meta)} />
        </div>
        {item.labels.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <LabelBadges labels={item.labels} meta={meta} />
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
          <span>{copy('detail.created', { at: item.created_at })}</span>
          <span>{copy('detail.updated', { at: item.updated_at })}</span>
        </div>

        <div style={{ ...NOTE, marginTop: 12 }}>{copy('detail.body')}</div>
        <BodyView copy={copy} body={item.body} />
        {truncated && <p style={NOTE}>{copy('panel.truncated')}</p>}
      </div>
    </>
  );
}
