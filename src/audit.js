'use strict';

const { trace } = require('./trace');

/**
 * 清洗效果审计引擎（纯函数，只读）
 *
 * 对当前每一条清洗记录单独做一次「移除试算」：
 *   把这一条清洗从记录中移除（其余设备 / 批次 / 清洗记录原样保留），
 *   复用同一个 trace() 推演引擎重新推演，再与原始推演结果逐批对比。
 *
 * 判定为「该清洗阻断的批次污染」需同时满足：
 *   1. 移除该清洗后，某批次的最终过敏原中新增了这种过敏原；
 *   2. 原始推演的最终过敏原中本就不含它。
 * （配方自带过敏原在两种情景下都在最终集合中，天然不会进入差集，
 *   因此命中的必然是交叉污染继承项。）
 *
 * 每项命中列出批次、过敏原，以及「移除情景下」该批首次继承该过敏原的
 * 设备、时间与步骤序号。移除后没有任何新增污染的清洗，标记为
 * 「当前无可见收益」（effective=false）。
 *
 * 多条清洗共同作用（冗余防护）时，本审计不做组合移除，只按
 * 「单条移除」的结果分别评价每一条。
 *
 * 本函数不读取也不写入持久化记录：trace() 为不修改入参的纯函数，
 * 移除试算只在内存中构造「少一条清洗」的记录视图，不落盘、不产生新 ID。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} baseData 原始记录
 * @param {object} [baseTrace] 可选：当前记录的推演结果（缺省时现场推演一次）
 * @returns {object} 审计结果 { summary, cleanings, message }
 */
function auditCleanings(baseData, baseTrace) {
  const baseline = baseTrace || trace(baseData);
  const baselineFinal = new Map(
    (baseline.batches || []).map((b) => [b.batchId, new Set(b.finalAllergens)])
  );

  const equipment = baseData.equipment || [];
  const cleanings = baseData.cleanings || [];
  const eqName = new Map(equipment.map((eq) => [eq.id, eq.name]));

  // 按时间升序逐条审计（与时间线一致的展示顺序）。
  const sorted = [...cleanings].sort((a, b) =>
    a.time === b.time
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.time < b.time
        ? -1
        : 1
  );

  const entries = sorted.map((c) => {
    // 移除试算：仅少这一条清洗的记录视图（浅拷贝即可，trace 不修改入参）。
    const scenarioTrace = trace({
      equipment,
      batches: baseData.batches,
      cleanings: cleanings.filter((x) => x.id !== c.id),
    });

    // 移除情景下每批每种过敏原的首次继承信息（时间线已按时间升序，
    // 某过敏原首次出现在该批接触事件的 inherited 中即首次继承）。
    const firstInherit = new Map(); // batchId -> Map(allergen -> info)
    for (const ev of scenarioTrace.timeline || []) {
      if (ev.type !== 'contact') continue;
      for (const inh of ev.inherited || []) {
        let m = firstInherit.get(ev.batchId);
        if (!m) {
          m = new Map();
          firstInherit.set(ev.batchId, m);
        }
        if (!m.has(inh.allergen)) {
          m.set(inh.allergen, {
            time: ev.time,
            equipmentId: ev.equipmentId,
            equipmentName: ev.equipmentName,
            stepIndex: ev.stepIndex,
          });
        }
      }
    }

    // 逐批对比：仅计「移除后新增、且原结果最终不含」的过敏原。
    // scenarioTrace.batches 已按批次时间排序，过敏原沿用推演输出的排序。
    const blocked = [];
    for (const br of scenarioTrace.batches || []) {
      const before = baselineFinal.get(br.batchId) || new Set();
      const inheritMap = firstInherit.get(br.batchId);
      for (const allergen of br.finalAllergens) {
        if (before.has(allergen)) continue;
        const first = inheritMap ? inheritMap.get(allergen) : null;
        blocked.push({
          batchId: br.batchId,
          batchName: br.name,
          batchTime: br.time,
          allergen,
          first: first
            ? {
                time: first.time,
                equipmentId: first.equipmentId,
                equipmentName: first.equipmentName,
                stepIndex: first.stepIndex,
              }
            : null,
        });
      }
    }

    return {
      cleaningId: c.id,
      time: c.time,
      equipmentId: c.equipmentId,
      equipmentName: eqName.get(c.equipmentId) || c.equipmentId,
      allergens: [...(c.allergens || [])],
      note: c.note || '',
      effective: blocked.length > 0,
      blockedCount: blocked.length,
      blocked,
    };
  });

  const summary = {
    total: entries.length,
    effective: entries.filter((e) => e.effective).length,
    noVisibleBenefit: entries.filter((e) => !e.effective).length,
    blockedTotal: entries.reduce((n, e) => n + e.blockedCount, 0),
  };

  const message = !summary.total
    ? '当前没有清洗记录可审计。'
    : summary.effective
      ? `共审计 ${summary.total} 条清洗记录：${summary.effective} 条正在阻断共 ${summary.blockedTotal} 项批次污染，` +
        `${summary.noVisibleBenefit} 条移除后没有新增污染（当前无可见收益）。`
      : `共审计 ${summary.total} 条清洗记录：单独移除任何一条都不会产生新的批次污染，当前均无可见收益。`;

  return { summary, cleanings: entries, message };
}

module.exports = { auditCleanings };
