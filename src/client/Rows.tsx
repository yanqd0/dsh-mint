/**
 * The list rows, shared by every surface that draws a list.
 *
 * Extracted so the three outer lists and the lists embedded in a container
 * detail cannot drift apart: they all call these, and only the data source
 * differs (the outer ones page and filter; an embedded one shows everything its
 * container holds).
 */
import type { ReactElement } from 'react';

import type { IssueItem, LabelItem, MintMetaPayload } from '../shared/records.js';
import type { CopyTranslate } from './copy.js';
import type { ContainerRow, PlacementView } from './model.js';
import { issueHeadline, issueMeta, issuePlacement, statusTone } from './model.js';
import { LABELS, META, NOTE, ROW, labelBadge, placementChip, pill } from './styles.js';

export interface LabelBadgesProps {
  labels: readonly string[];
  /** The label dictionary, where every color lives; absent until it loads. */
  meta: MintMetaPayload | undefined;
}

/**
 * One line of label badges, each tinted by the color mint recorded for it.
 *
 * An issue carries label names only, so a name the dictionary does not know (or
 * a color it cannot trust) still renders — as a neutral chip.
 *
 * @param props - the label names and the dictionary they are looked up in.
 */
export function LabelBadges({ labels, meta }: LabelBadgesProps): ReactElement | null {
  if (labels.length === 0) return null;
  const known = new Map<string, LabelItem>(
    (meta?.labels ?? []).map((label) => [label.name, label])
  );
  return (
    <span style={LABELS}>
      {labels.map((name) => {
        const label = known.get(name);
        return (
          <span
            key={name}
            style={labelBadge(label?.color ?? '')}
            title={label?.description ?? undefined}
          >
            {name}
          </span>
        );
      })}
    </span>
  );
}

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
        <span style={placementChip('plan')} title={copy('placement.plan')}>
          {`#${String(planId)}`}
        </span>
      )}
      {milestoneVersion !== undefined && (
        <span
          style={placementChip(direct ? 'direct' : 'viaPlan')}
          title={copy(direct ? 'placement.milestone' : 'placement.milestoneViaPlan')}
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
      <LabelBadges labels={item.labels} meta={meta} />
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
