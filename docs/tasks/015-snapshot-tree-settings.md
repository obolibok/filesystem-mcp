# 015: отдельные настройки экспериментального snapshot_tree

Статус: ready for implementation. Планирование ведёт
[центральную доску](../project/status.md). Основание — пожелание пользователя
28.10.2026, [реальный опыт 014](../testing/014-independent-live-2026-10-29.md) и
ошибка запуска комплекта от 29.10.2026: portable config validator отклонил
`FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES` как неизвестный ключ.

## Проблема

С общим raw part 45 MiB и delivery 8 MiB stable обработал 2843566 файлов,
а tree остановился на первой ZIP-part. Для повтора приходится менять общий
FS_SNAPSHOT_MAX_RAW_PART_BYTES, затрагивая stable partitioning/reuse.
Пользователь предложил отдельные настройки эксперимента. «Не лепить Боинг»:
нужен отдельный format knob, а не копия server config/lifecycle.

## Предлагаемый минимальный контракт

- Сохранить experimentalSnapshotTree boolean и opt-in discovery.
- Отдельная настройка сырого размера части только для tree: optional env
  `FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES`, задаваемая в portable config как ключ
  `limits.FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES` — тот же стиль и место, что у
  остальных `FS_*` лимитов. Это точный ключ, который пользователь уже добавил.
  Допустимый диапазон совпадает с `FS_SNAPSHOT_MAX_RAW_PART_BYTES`
  (64 KiB–512 MiB). Если ключ отсутствует, tree сохраняет прежнее поведение,
  используя общий `FS_SNAPSHOT_MAX_RAW_PART_BYTES`; рабочее значение для повтора
  R2 — 16 MiB (16777216 bytes).
- Stable FS_SNAPSHOT_MAX_RAW_PART_BYTES, CSV/identities/artifacts оставить
  прежними. Effective tree knob учитывается только в tree automatic reuse
  identity и manifest policy. Idempotency-семантику не менять.
- Tree-only change не инвалидирует stable completed/in-flight reuse/bytes.
- PathGuard/source policy, jobs/artifacts/TTL/quota/deadline и delivery ceilings
  остаются общими. Не расширять предел доставки ради эксперимента.
- Portable строго валидирует тип/границы, очищает inherited env; ошибочное
  значение не включает эксперимент и не меняет stable config.
- Tree raw cap поступает в tree pipeline до разбиения частей. Общие ZIP,
  delivery, job, scratch/quota и TTL лимиты не увеличиваются и не становятся
  tree-only.
- Меньший raw cap не гарантирует любой compression ratio: общий конечный ZIP
  cap и явный TOO_LARGE сохраняются.

## Acceptance будущей реализации

1. Разные raw part caps одновременно работают у stable/tree в одном процессе.
2. Tree-only config change не меняет stable fingerprints/reuse/bytes; tree reuse
   разделён по effective cap. Проверены completed, in-flight, restart/flag off.
3. Manifest/counters отражают actual policy и все root/header/C/U bytes.
4. Synthetic noisy profile воспроизводит closed-ZIP failure при большом cap и
   проходит с меньшим cap, без production inventories.
5. Default 19/13 и opt-in 20/14 tools, guards/lifecycle/общие ceilings сохранены.
6. Docs/portable sample; regression tests подтверждают, что ошибочное значение
   отвергается до запуска и что stable/tree используют разные raw caps в одном
   процессе.
7. `npm run check` и portable builder/`Verify.mjs` проходят. Новая сборка
   сохраняется в ignored `out/` с BUILD metadata и SHA-256; пользовательские
   корни и production artifacts в неё не входят.

Adaptive repartition по compressed size, новая БД, новые discovery tools,
настройка tree ZIP/delivery cap и полная матрица tree-only limits сюда не входят.
Текущий 014 live не повторять до получения новой сборки.

## Work record

Заполняет исполнитель: база/ветка, реализация, выбранные детали контракта,
команды и результаты проверок, skips, ограничения и handoff планированию.
