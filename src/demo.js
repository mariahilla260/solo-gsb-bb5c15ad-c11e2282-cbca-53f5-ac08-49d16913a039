'use strict';

/**
 * 演示数据：4 台共用设备 + 4 个批次 + 2 条清洗记录。
 * 跨污染链路：
 *   批次A（含小麦）08:00 先用搅拌缸，残留小麦；
 *   批次B（含鸡蛋）09:00 用同一搅拌缸 → 继承小麦，随后把小麦带到烤箱；
 *   08:30 搅拌缸清洗移除「鸡蛋」（当时并无鸡蛋，故无效）；
 *   10:30 搅拌缸清洗移除「小麦」，残留清空；
 *   批次C（含乳）11:00 使用烤箱 → 继承小麦（来自批次B的留渍）；
 *   批次D（含芝麻）12:00 再用搅拌缸 → 继承鸡蛋；若 10:30 的小麦清洗被移除，
 *   还会额外继承小麦（用于演示清洗效果审计的阻断收益）。
 * 标签声明示例（用于包装标签核对）：
 *   批次A 声明与最终一致；批次B 漏报交叉污染继承的小麦；
 *   批次C 漏报小麦且多报芝麻；批次D 尚未填写标签声明。
 */

function buildDemoData(prefixId) {
  const eq = {
    mixer: prefixId('eq'),
    oven: prefixId('eq'),
    filler: prefixId('eq'),
    sealer: prefixId('eq'),
  };
  const ba = prefixId('b');
  const bb = prefixId('b');
  const bc = prefixId('b');
  const bd = prefixId('b');

  const batches = [
    {
      id: ba,
      name: 'A批-全麦面团',
      time: '2026-09-25T08:00',
      allergens: ['小麦（含麸质）'],
      labelAllergens: ['小麦（含麸质）'],
      steps: [
        { equipmentId: eq.mixer, time: '2026-09-25T08:00', note: '和面 15 分钟' },
        { equipmentId: eq.oven, time: '2026-09-25T08:30', note: '' },
      ],
    },
    {
      id: bb,
      name: 'B批-蛋香糕点',
      time: '2026-09-25T09:00',
      allergens: ['鸡蛋'],
      labelAllergens: ['鸡蛋'],
      steps: [
        { equipmentId: eq.mixer, time: '2026-09-25T09:00', note: '打蛋糊' },
        { equipmentId: eq.oven, time: '2026-09-25T09:30', note: '' },
        { equipmentId: eq.filler, time: '2026-09-25T10:00', note: '' },
      ],
    },
    {
      id: bc,
      name: 'C批-奶香布丁',
      time: '2026-09-25T11:00',
      allergens: ['乳（含乳糖）'],
      labelAllergens: ['乳（含乳糖）', '芝麻'],
      steps: [
        { equipmentId: eq.oven, time: '2026-09-25T11:00', note: '蒸烤' },
        { equipmentId: eq.filler, time: '2026-09-25T11:30', note: '' },
        { equipmentId: eq.sealer, time: '2026-09-25T11:45', note: '' },
      ],
    },
    {
      id: bd,
      name: 'D批-芝麻薄脆',
      time: '2026-09-25T12:00',
      allergens: ['芝麻'],
      // 尚未填写标签声明（null），演示「⬜ 尚未填写」的核对状态。
      labelAllergens: null,
      steps: [
        { equipmentId: eq.mixer, time: '2026-09-25T12:00', note: '换产后首批' },
      ],
    },
  ];

  const cleanings = [
    {
      id: prefixId('c'),
      equipmentId: eq.mixer,
      time: '2026-09-25T08:30',
      allergens: ['鸡蛋'],
      note: '开班前常规冲洗（当时设备上无鸡蛋残留，演示无效清洗）',
    },
    {
      id: prefixId('c'),
      equipmentId: eq.mixer,
      time: '2026-09-25T10:30',
      allergens: ['小麦（含麸质）'],
      note: '换产深度清洗',
    },
  ];

  const equipment = [
    { id: eq.mixer, name: '1号搅拌缸' },
    { id: eq.oven, name: '2号烤箱' },
    { id: eq.filler, name: '3号灌装机' },
    { id: eq.sealer, name: '4号封口机' },
  ];

  return { equipment, batches, cleanings };
}

module.exports = { buildDemoData };
