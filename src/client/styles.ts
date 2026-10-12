/**
 * mint 面板共用的样式对象。
 *
 * 只用主题 token（`--dsw-*`），面板因此继承页面的明暗配色，而不自带一套；对象按引用
 * 共享，整个面板由此保持一致，客户端包里也不需要 CSS 管线。
 */
import type { CSSProperties } from 'react';

import type { DagTone } from './dag-model.js';
import type { StatusTone } from './model.js';

export const SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
};

export const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flex: 'none',
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

export const TAB: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
};

export const TAB_ACTIVE: CSSProperties = {
  ...TAB,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
};

export const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  padding: '6px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
};

export const BUTTON: CSSProperties = {
  ...TAB,
  border: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
};

export const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  padding: '3px 6px',
};

export const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 10,
};

/** 正文区的首行：左侧「正文」标签，右侧预览 / 代码模式切换控件。 */
export const BODY_HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 12,
};

export const NOTE: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
};

/** 包住单个筛选勾选框的 label，两个列表因此排布一致。 */
export const FILTER_LABEL: CSSProperties = {
  ...NOTE,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

export const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  padding: '8px 4px',
  cursor: 'pointer',
};

export const META: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
};

export const PROSE: CSSProperties = {
  margin: '8px 0 0',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
};

/** 承载 mint 生命周期状态的小胶囊。 */
export function pill(tone: StatusTone): CSSProperties {
  return {
    color: `var(--dsw-alias-state-${tone}-primary)`,
    border: `1px solid var(--dsw-alias-state-${tone}-primary)`,
    borderRadius: 999,
    padding: '0 6px',
    fontSize: 10,
    lineHeight: '16px',
  };
}

/** label 颜色在被信任地插进 CSS 之前，允许出现的字符集。 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * 承载单个 label 的徽标。
 *
 * 几何形状对齐宿主 shell 的 `Tag`（固定胶囊，只有配色可变），但配色用的是 mint 为这个
 * label 记下的颜色而非主题色调。该值经 CLI 从数据库里出来，故在这里校验：认不出的颜色
 * 退回中性 chip，而不是被插进 CSS。
 */
export function labelBadge(color: string): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 0.5,
    borderStyle: 'solid',
    padding: '1px 8px',
    fontSize: 11,
    lineHeight: '17px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  };
  if (!HEX_COLOR.test(color)) {
    return {
      ...base,
      color: 'var(--dsw-alias-label-tertiary)',
      borderColor: 'var(--dsw-alias-border-l4)',
      background: 'var(--dsw-alias-bg-layer-2)',
    };
  }
  return {
    ...base,
    color,
    borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
  };
}

/** 一行行内 label 徽标所在的横排。 */
export const LABELS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
};

export type PlacementKind = 'plan' | 'direct' | 'viaPlan';

/**
 * 承载一处父级引用的小 chip。
 *
 * plan 只是一个安静胶囊里的 id；milestone 在属于 issue 自身时用主色、经 plan 关联时降为
 * 虚线次色——这个差别正是两者都显示出来的意义。
 */
export function placementChip(kind: PlacementKind): CSSProperties {
  const base: CSSProperties = {
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    padding: '0 6px',
    fontSize: 10,
    lineHeight: '16px',
  };
  switch (kind) {
    case 'plan':
      return {
        ...base,
        color: 'var(--dsw-alias-label-secondary)',
        borderColor: 'var(--dsw-alias-border-l1)',
      };
    case 'direct':
      return {
        ...base,
        color: 'var(--dsw-alias-label-primary)',
        borderColor: 'var(--dsw-alias-label-primary)',
      };
    case 'viaPlan':
      return {
        ...base,
        color: 'var(--dsw-alias-label-secondary)',
        borderColor: 'var(--dsw-alias-border-l2)',
        borderStyle: 'dashed',
      };
  }
}

/**
 * DAG 面板的外框：列方向排布与 {@link SHELL} 相同，只是没有 header——这个面板就是一块
 * 可滚动画布加一行摘要。
 */
export const DAG_SHELL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: 'var(--dsw-alias-label-primary)',
};

/**
 * SVG 外面的滚动视口。
 *
 * `position: relative` 是悬停 tooltip 的定位锚点，且必须落在画布上而不是节点上：绝对定位
 * 的 tooltip 放进 `<svg>` 里，各家引擎的排版并不一致。
 */
export const DAG_CANVAS: CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: 8,
};

/**
 * 悬停 tooltip：节点全文紧挨着它的盒子显示。
 *
 * `maxHeight` 加 `overflow: auto` 是规格里定下的契约——节点的 `note` 是子代理结论的逐字
 * 引用，可能很长，tooltip 要滚动，而不是撑出面板。
 */
export const DAG_TOOLTIP: CSSProperties = {
  position: 'absolute',
  zIndex: 1,
  maxWidth: 320,
  maxHeight: 240,
  overflow: 'auto',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  pointerEvents: 'none',
};

/** 脉动节点带的 class；它的 keyframes 定义在 body 的 `<style>` 里。 */
export const DAG_RUNNING_CLASS = 'dsh-mint-dag-running';

/**
 * 单个节点盒子的样式，按色调着色。
 *
 * 填充是把色调混进面板自己的层里，节点因此保留页面的明暗表面而不至于变成一块死色；描边
 * 用满强度的色调，`running` 由此比 `done` 更亮。
 */
export function dagNodeStyle(tone: DagTone): CSSProperties {
  const token = `var(--dsw-alias-state-${tone}-primary)`;
  return {
    fill: `color-mix(in srgb, ${token} 12%, var(--dsw-alias-bg-layer-1))`,
    stroke: token,
    strokeWidth: 1.5,
  };
}

/** 节点标签的 SVG 文本样式：六码点、不省略的标签放在其中。 */
export const DAG_NODE_LABEL: CSSProperties = {
  fill: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
};

/**
 * 阶段带的外框：虚线、极淡填充，好让读者看见分区而不把它误认成一个巨大的节点。
 *
 * 填充是把它自己那一层压到 35% 透明上，带框因此在明暗两种主题下都只是一层薄纱。
 */
export function dagStageStyle(): CSSProperties {
  return {
    fill: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 35%, transparent)',
    stroke: 'var(--dsw-alias-border-l2)',
    strokeWidth: 1,
    strokeDasharray: '4 4',
  };
}

/** 阶段带左上角的表头：比节点标签小一号、次色，读起来是框的一部分而不是一个节点。 */
export const DAG_STAGE_LABEL: CSSProperties = {
  fill: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  fontFamily: 'inherit',
};

/**
 * 节点的第二行：实测指标对，比标签小一号。
 *
 * 它继承标签的字体，让节点读起来是一整块文字；字号小到两个数字连同单位都塞得进 104px 的
 * 盒子。
 */
export const DAG_NODE_METRICS: CSSProperties = {
  fontSize: 9,
  fontFamily: 'inherit',
};

/**
 * 宿主实测的令牌数所用颜色。
 *
 * 琥珀是主题的告警色，在这套配色里同时也是钱的颜色：实测计数就是花掉的预算，这一行用主题
 * 本来就为它准备好的状态色，而不另造一个色相。
 */
export const LIVE_TOKENS_COLOR = 'var(--dsw-alias-state-warn-primary)';

/**
 * 宿主实测的耗时所用颜色。
 *
 * 这套主题没有紫色的 alias token——全部 `--dsw-*` token 都查过，紫色只活在 onboarding
 * 渐变和 shiki 的语法配色里——所以这一行用受控的字面量，与 {@link labelBadge} 为 label
 * 自带颜色所做的让步相同。它必须人工跟上页面的明暗表面。
 */
export const LIVE_TIME_COLOR = '#8b76f6';

export function dagLiveTokensStyle(): CSSProperties {
  return { fill: LIVE_TOKENS_COLOR };
}

export function dagLiveTimeStyle(): CSSProperties {
  return { fill: LIVE_TIME_COLOR };
}

/** tooltip 里的一行：技术字段在正文面前是次要的。 */
export const DAG_TOOLTIP_META: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
};

/**
 * 子代理树一行的盒子：与 DAG 节点**同一套着色**（色调混进面板层 + 满强度描边），只是宽高由
 * 调用方按内容给——它的标签是派发时的 description，比六字节点标签长得多。
 */
export function agentRowStyle(tone: 'success' | 'idle'): CSSProperties {
  const token = `var(--dsw-alias-state-${tone}-primary)`;
  return {
    fill: `color-mix(in srgb, ${token} 12%, var(--dsw-alias-bg-layer-1))`,
    stroke: token,
    strokeWidth: 1.5,
  };
}

/**
 * 树里连接父子的肘线：与 DAG 的边**同一个颜色**，只是画在行与行之间的缩进空隙里。
 *
 * 用次级描边色而非状态色：它说的是「谁挂在谁下面」，与那一行在不在跑无关。
 */
export const AGENT_ELBOW: CSSProperties = {
  fill: 'none',
  stroke: 'var(--dsw-alias-border-l2)',
  strokeWidth: 1.5,
};

/** 行标签的字号：与 DAG 节点标签同号，两棵树因此读起来是一套。 */
export const AGENT_ROW_LABEL: CSSProperties = {
  fill: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
};

/** 行右侧的数字格：与 DAG 节点的第二行同号（9px）。 */
export const AGENT_ROW_METRICS: CSSProperties = {
  fontSize: 9,
  fontFamily: 'inherit',
};
