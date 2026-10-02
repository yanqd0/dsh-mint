/**
 * The list rows, shared by every surface that draws a list.
 *
 * Extracted so the three outer lists and the lists embedded in a container
 * detail cannot drift apart: they all call these, and only the data source
 * differs (the outer ones page and filter; an embedded one shows everything its
 * container holds).
 */
import type { ReactElement } from 'react';

import type { IssueItem, MintMetaPayload } from '../records.js';
import type { CopyTranslate } from './copy.js';
import type { ContainerRow, PlacementView } from './model.js';
import { issueHeadline, issueMeta, issuePlacement, labelSummary, statusTone } from './model.js';
import { META, NOTE, ROW, placementChip, pill } from './styles.js';

export interface PlacementChipsProps {
  copy: CopyTranslate;
  /** `undefined` when the row has no placement the panel can state. */
  placement: PlacementView | undefined;
}

/**
 * The parent references one issue carries: its plan, and the milestone that
 * follows from it.
 *
 * @param props - the copy seat and the resolved placement.
 */
export function PlacementChips({ copy, placement }: PlacementChipsProps): ReactElement | null {
  if (placement === undefined) return null;
  const { planId, milestoneVersion, direct } = placement;
  return (
    <>
      {planId !== null && (
        <span style={placementChip('plan')} title={copy('field.plan')}>
          {`#${String(planId)}`}
        </span>
      )}
      {milestoneVersion !== undefined && (
        <span
          style={placementChip(direct ? 'direct' : 'viaPlan')}
          title={direct ? copy('field.milestone') : `${copy('field.milestone')} · ${copy('placement.viaPlan')}`}
        >
          {direct ? milestoneVersion : `↳ ${milestoneVersion}`}
        </span>
      )}
    </>
  );
}

export interface IssueRowProps {
  copy: CopyTranslate;
  item: IssueItem;
  /** The lookup tables; absent while they load, or after a failed read. */
  meta: MintMetaPayload | undefined;
  onSelect: (item: IssueItem) => void;
}

/**
 * One issue: title, then status and where it sits, then its labels on their own
 * line.
 *
 * @param props - copy, the record, the lookup tables, and the select callback.
 */
export function IssueRow({ copy, item, meta, onSelect }: IssueRowProps): ReactElement {
  const placement = issuePlacement(item, meta);
  const labels = labelSummary(item.labels);
  return (
    <button
      type="button"
      style={ROW}
      onClick={() => {
        onSelect(item);
      }}
    >
      <span>{issueHeadline(item)}</span>
      <span style={META}>
        <span style={pill(statusTone(item.status))}>{item.status}</span>
        <span>{issueMeta(item)}</span>
        <PlacementChips copy={copy} placement={placement} />
      </span>
      {labels !== undefined && <span style={NOTE}>{labels}</span>}
    </button>
  );
}

export interface ContainerRowViewProps {
  row: ContainerRow;
  onSelect: () => void;
}

/**
 * One plan or milestone row.
 *
 * @param props - the projected row and the select callback.
 */
export function ContainerRowView({ row, onSelect }: ContainerRowViewProps): ReactElement {
  return (
    <button type="button" style={ROW} onClick={onSelect}>
      <span>{`#${String(row.id)} ${row.title}`}</span>
      <span style={NOTE}>{row.meta}</span>
    </button>
  );
}
