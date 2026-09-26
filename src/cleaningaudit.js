'use strict';

const { trace, sortAllergens } = require('./trace');

/**
 * 清洗效果审计引擎（纯函数，只读）
 *
 * 对当前记录中的每一条清洗单独做一次「移除试算」：
 * 把该条清洗从记录中去掉（其余记录原样），复用同一个 trace() 推演引擎
 * 重新推演，再与包含全部清洗的基线推演逐批对比最终过敏原集合：
 *
 *   某批某过敏原「仅在移除后新增、且原（基线）结果最终不含」时，
 *   才计为该清洗阻断的一项批次污染。
 *
 * 对每项被阻断的污染，给出批次、过敏原，以及移除情景下该批首次继承
 * 该过敏原的设备、时间与步骤序号。移除后没有任何批次新增最终过敏原的
 * 清洗，标记为「当前无可见收益」。多条清洗共同作用（单条移除都不显现）
 * 时，按单条移除结果分别评价，不做联合移除。
 *
 * 本函数不读取也不写入持久化记录：trace() 为不修改入参的纯函数，
 * 移除只发生在内存中临时组装的记录副本上，不落盘、不产生新 ID。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} baseData 原始记录
 * @param {object} [baselineTrace] 可选：已算好的基线推演结果（trace(baseData)），
 *                                 传入可避免重复推演；不传则内部自行推演。
 * @returns {object} { summary, cleanings }
 */
function auditCleanings(baseData, baselineTrace) {
  const data = {
    equipment: baseData.equipment || [],
    batches: baseData.batches || [],
    cleanings: baseData.cleanings || [],
  };

  // 基线推演（包含全部清洗的原始记录）
  const baseline = baselineTrace || trace(data);
  const baselineFinal = new Map(
    (baseline.batches || []).map((b) => [b.batchId, new Set(b.finalAllergens)])
  );

  // 基线时间线中每条清洗「当时实际移除」的过敏原（勾选但当时设备上并没有的
  // 过敏原不计入），用于展示清洗当时的直接效果、辅助解释审计结论。
  const actuallyRemoved = new Map();
  for (const ev of baseline.timeline || []) {
    if (ev.type === 'cleaning') {
      actuallyRemoved.set(ev.cleaningId, ev.removed || []);
    }
  }

  const eqName = new Map(data.equipment.map((eq) => [eq.id, eq.name]));

  // 展示顺序与残留传播时间线一致：按清洗时间升序，同刻按 id 稳定排序。
  const ordered = [...data.cleanings].sort((a, b) =>
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

  const cleanings = ordered.map((c) => {
    // 移除情景：仅从记录中去掉这一条清洗，其余记录原样，复用同一推演引擎。
    const scenarioTrace = trace({
      equipment: data.equipment,
      batches: data.batches,
      cleanings: data.cleanings.filter((x) => x.id !== c.id),
    });
    const firstInherit = collectFirstInherit(scenarioTrace);

    // 逐批对比：移除后新增、且基线最终不含的过敏原即被本清洗阻断的污染。
    // （配方自带过敏原两个情景完全一致，天然不会进入差集，故差集必为
    //  交叉污染继承，首次继承事件必然存在；仍做防御性兜底。）
    const blocked = [];
    for (const br of scenarioTrace.batches || []) {
      const baseSet = baselineFinal.get(br.batchId) || new Set();
      for (const allergen of br.finalAllergens) {
        if (baseSet.has(allergen)) continue;
        blocked.push({
          batchId: br.batchId,
          batchName: br.name,
          batchTime: br.time,
          allergen,
          first: firstInherit.get(`${br.batchId}|${allergen}`) || null,
        });
      }
    }
    // scenarioTrace.batches 已按（批次时间, 批次 id）排序，finalAllergens
    // 已按过敏原目录序排序，因此 blocked 天然按批次时间、过敏原有序。

    return {
      cleaningId: c.id,
      time: c.time,
      equipmentId: c.equipmentId,
      equipmentName: eqName.get(c.equipmentId) || c.equipmentId,
      allergens: sortAllergens(c.allergens || []),
      note: c.note || '',
      actuallyRemoved: actuallyRemoved.get(c.id) || [],
      hasVisibleBenefit: blocked.length > 0,
      blockedCount: blocked.length,
      blocked,
    };
  });

  const summary = {
    total: cleanings.length,
    withBenefit: cleanings.filter((c) => c.hasVisibleBenefit).length,
    noBenefit: cleanings.filter((c) => !c.hasVisibleBenefit).length,
    blockedTotal: cleanings.reduce((n, c) => n + c.blockedCount, 0),
  };

  return { summary, cleanings };
}

/**
 * 收集一次推演中「每批每种过敏原的首次继承事件」。
 * 时间线已按时间升序，某过敏原首次出现在该批接触事件的 inherited 中即
 * 首次继承（推演规则下同批同种过敏原至多继承一次）。
 */
function collectFirstInherit(traceResult) {
  const first = new Map(); // `${batchId}|${allergen}` -> { time, equipmentId, equipmentName, stepIndex }
  for (const ev of traceResult.timeline || []) {
    if (ev.type !== 'contact') continue;
    for (const inh of ev.inherited || []) {
      const key = `${ev.batchId}|${inh.allergen}`;
      if (!first.has(key)) {
        first.set(key, {
          time: ev.time,
          equipmentId: ev.equipmentId,
          equipmentName: ev.equipmentName,
          stepIndex: ev.stepIndex,
        });
      }
    }
  }
  return first;
}

module.exports = { auditCleanings };
