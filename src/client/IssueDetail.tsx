/**
 * 单条 issue 详情：身份、归位、标签、链接与正文。item 来自 `show --json`，
 * 故只渲染路由已校验的字段，不从列表行带任何字段过来。
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
  /** milestone 的版本标签在查找表里，详情要用它。 */
  meta: MintMetaPayload | undefined;
  /** 路由按字节预算截断正文时为 true。 */
  truncated: boolean;
  onBack: () => void;
}

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
