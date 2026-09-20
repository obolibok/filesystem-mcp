# Synthetic snapshot benchmark: 2026-09-20

Задача: [003](../tasks/003-compressed-snapshot.md). Все входы synthetic; production
пути, inventories и документы не использовались. Прогоны выполнены на Windows,
Node.js 24.15.0. Verifier независимо открывает каждую ZIP-часть через `yauzl`,
проверяет SHA-256, потоково разбирает CSV через `csv-parse`, проверяет header,
шесть полей, Length/time и суммарное число записей. Он дожидается конца всего ZIP,
требует ровно один CSV entry и независимо вычисляет CRC-32 распакованных bytes.
Header проверяется при чтении первой строки, поэтому неверная schema отклоняется
и в пустом snapshot. Отрицательные fixtures для пустого CSV с неверным header,
второго entry, неверного CRC, усечения и повреждённых compressed bytes входят в
regression suite.

## Воспроизведение

```powershell
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 100000
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 3000000
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 300000 --entropy high --expect-failure
node --import tsx scripts/snapshot-benchmark/run.mts --mode walk --walk-files 21000 --records 1
node --import tsx scripts/snapshot-benchmark/run.mts --mode walk --walk-files 60000 --records 1
```

Каждый запуск создаёт отдельные source/scratch каталоги через `mkdtemp` и удаляет
их в `finally`. Большой metadata pipeline генерирует записи на лету и не создаёт
3 млн файлов. Настоящий walk — отдельный режим с 21 000 и 60 000 файлами,
корневым `.gitignore` и exact set compare на одинаковых caps/instrumentation.

## Результаты

| Профиль        |      Rows |       Raw CSV |          ZIP | Parts |   Elapsed |      Peak RSS |    Peak heap | Peak scratch |
| -------------- | --------: | ------------: | -----------: | ----: | --------: | ------------: | -----------: | -----------: |
| pipeline-small |   100 000 |  15 788 947 B |  1 698 026 B |     1 |   4,234 s | 120 557 568 B | 41 307 184 B | 17 429 012 B |
| pipeline-large | 3 000 000 | 478 889 517 B | 50 373 149 B |    11 | 126,193 s | 236 859 392 B | 76 497 952 B | 96 691 088 B |
| walk-21k       |    21 000 |   1 873 045 B |    121 455 B |     1 |  6,641 s¹ | 136 376 320 B | 56 489 264 B |  1 995 520 B |
| walk-60k       |    60 000 |   5 392 693 B |    346 911 B |     1 | 24,037 s¹ | 159 977 472 B | 72 205 040 B |  5 573 985 B |

¹ Время walk считает snapshot и verifier после создания fixture; создание файлов
намеренно измеряется отдельно от metadata pipeline.

Большой прогон попал в целевой диапазон 450–500 MB raw и остался ниже ориентира
256 MiB peak RSS (268 435 456 B). Рост от small к large: строк в 30 раз больше,
peak RSS в 1,96 раза, heap в 1,85 раза; память не растёт пропорционально числу строк.
Base64 готовых артефактов большого прогона — 67 170 696 символов. Все 3 млн строк,
11 ZIP/CSV частей, CRC-32 и hashes проверены до полного конца архивов; errors=0.

Pipeline-small и pipeline-large повторены после усиления проверки header по замечанию
R8 review; verifier вернул `verified: true` для обоих профилей. Walk-профили и
poor-compression не зависят от этой проверки успешного CSV и здесь не перезапускались.

Walk-21k посетил 106 каталогов и увидел 21 107 entries; walk-60k — 301 каталог
и 60 302 entries. Оба записали точные expected sets и исключили один каталог по
`.gitignore`; errors=0. При 2,86× файлов peak RSS вырос в 1,17×, peak heap — в 1,28×.
Это отдельная проверка исправления bounded cache для уникальных ignore paths;
nested rules/negation после многократного сброса cache покрыты regression test.
Fixture включает Unicode и файлы без расширения. Symlink/junction, исчезновение,
access narrowing и quoting/multiline дополнительно покрыты regression suite задачи.

## Плохо сжимаемые metadata

Профиль `300000 --entropy high` завершился ожидаемым bounded failure за 10,726 s:
`Closed ZIP part would exceed effective deliverable cap 8388608 bytes`. Peak RSS
124 817 408 B, heap 44 065 576 B, scratch 55 526 414 B. Runner теперь утверждением
проверяет failed state, отсутствие manifest/ready artifacts и отсутствие `.partial`;
`partialArtifacts: 0`. Это намеренный v1 контракт: закрытый ZIP не выходит за
эффективный минимум ZIP/delivery/general-file caps; сложного повторного разбиения
по фактическому коэффициенту сжатия нет.

Числа — одиночные локальные измерения, не SLA сети или ChatGPT. Целевой live size
ladder и архив около 5,53 MB проверяются отдельно.
