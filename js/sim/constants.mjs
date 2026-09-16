/**
 * 仿真用拓扑/可达魔法常数（定性趋势，非真实网络推导）。
 */
export const MAILBOX_REACH_LOW_HOP_FACTOR = 0.45
/**
 * maxHop=2 时 mailbox 可达折损系数。
 */
export const MAILBOX_REACH_MID_HOP_FACTOR = 0.72
/**
 * 跳数成本指数（hopFactor 幂次）。
 */
export const MAILBOX_HOP_COST_EXPONENT = 1.5
/**
 * 跳数成本线性缩放系数。
 */
export const MAILBOX_HOP_COST_SCALE = 0.28
/**
 * wantFanout 超基准（3）的附加成本系数。
 */
export const MAILBOX_FANOUT_COST_SCALE = 0.05
/**
 * 超过必要跳数时的惩罚系数。
 */
export const MAILBOX_EXCESS_HOP_PENALTY = 0.24
/**
 * relay 步数归一化除数（分母项）。
 */
export const MAILBOX_RELAY_COST_DIVISOR = 6
/**
 * 联邦单 peer 覆盖概率上限。
 */
export const FEDERATION_SINGLE_PEER_CAP = 0.55
/**
 * 联邦单 peer 覆盖概率缩放（÷ 在线诚实 relay 数）。
 */
export const FEDERATION_SINGLE_PEER_SCALE = 1.4
/**
 * 攻击方发现门控基线概率（仿真代理）。
 */
export const ATTACK_DISCOVERY_GATE_BASE = 0.55
/**
 * Sybil 声誉收益冷却轮数（此前轮次不发放）。
 */
export const SYBIL_REP_EARN_COST_ROUNDS = 4
