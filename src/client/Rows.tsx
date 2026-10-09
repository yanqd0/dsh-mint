/**
 * 列表行组件，所有画列表的地方共用。
 *
 * 抽出来的目的就是不让三个外层列表与容器明细里的内嵌列表各自漂移：它们都调这里，区别只在
 * 数据来源（外层分页与过滤，内嵌显示容器持有的全部）。
 */
import type { ReactElement } from 'react';

import type { IssueItem, LabelItem, MintMetaPayload } from '../shared/records.js';
import type { CopyTranslate } from './copy.js';
import type { ContainerRow, PlacementView } from './model.js';
import { issueHeadline, issueMeta, issuePlacement, statusTone } from './model.js';
import { LABELS, META, NOTE, ROW, labelBadge, placementChip, pill } from './styles.js';

export interface LabelBadgesProps {
  labels: readonly string[];
  /** label 字典，颜色都在其中；加载完之前缺席。 */
  meta: MintMetaPayload | undefined;
}

/**
 * 一行 label 徽标，各自染上 mint 为它记下的颜色。
 *
 * issue 只带 label 名，所以字典不认的名字（或不可信的颜色）照样渲染成中性 chip。
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
  /** 行没有可陈述的归属时为 `undefined`。 */
  placement: PlacementView | undefined;
}

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
  /** 查表；加载中或读取失败之后缺席。 */
  meta: MintMetaPayload | undefined;
  onSelect: (item: IssueItem) => void;
}

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

export function ContainerRowView({ row, onSelect }: ContainerRowViewProps): ReactElement {
  return (
    <button type="button" style={ROW} onClick={onSelect}>
      <span>{`#${String(row.id)} ${row.title}`}</span>
      <span style={NOTE}>{row.meta}</span>
    </button>
  );
}
