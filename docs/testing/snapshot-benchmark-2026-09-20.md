# Synthetic snapshot benchmark: 2026-09-20

Задача: [003](../tasks/003-compressed-snapshot.md). Все входы synthetic; production
пути, inventories и документы не использовались. Прогоны выполнены на Windows,
Node.js 24.15.0. Verifier независимо открывает каждую ZIP-часть через `yauzl`,
проверяет SHA-256, потоково разбирает CSV через `csv-parse`, проверяет header,
шесть полей, Length/time и суммарное число записей.

## Воспроизведение

```powershell
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 100000
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 3000000
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 300000 --entropy high --expect-failure
node --import tsx scripts/snapshot-benchmark/run.mts --mode walk --walk-files 21000 --records 1
```

Каждый запуск создаёт отдельные source/scratch каталоги через `mkdtemp` и удаляет
их в `finally`. Большой metadata pipeline генерирует записи на лету и не создаёт
3 млн файлов. Настоящий walk — отдельный режим с 21 000 файлами и exact set compare.

## Результаты

| Профиль        |      Rows |       Raw CSV |          ZIP | Parts |   Elapsed |      Peak RSS |    Peak heap | Peak scratch |
| -------------- | --------: | ------------: | -----------: | ----: | --------: | ------------: | -----------: | -----------: |
| pipeline-small |   100 000 |  15 788 947 B |  1 698 026 B |     1 |   5,856 s | 132 177 920 B | 41 749 368 B | 17 489 430 B |
| pipeline-large | 3 000 000 | 478 889 517 B | 50 373 149 B |    11 | 152,320 s | 236 810 240 B | 76 750 992 B | 96 691 088 B |
| real-walk      |    21 000 |   1 873 045 B |    121 604 B |     1 |  8,021 s¹ | 140 468 224 B | 60 598 064 B |  1 902 915 B |

¹ Время `real-walk` считает snapshot и verifier после создания fixture; создание
21 000 файлов намеренно измеряется отдельно от metadata pipeline.

Большой прогон попал в целевой диапазон 450–500 MB raw и остался ниже ориентира
256 MiB peak RSS (268 435 456 B). Рост от small к large: строк в 30 раз больше,
peak RSS в 1,79 раза, heap в 1,84 раза; память не растёт пропорционально числу строк.
Base64 готовых артефактов большого прогона — 67 170 596 символов. Все 3 млн строк,
11 CRC-valid ZIP/CSV частей и hashes проверены; errors=0.

Настоящий walk посетил 106 каталогов, увидел 21 107 entries, записал ровно ожидаемые
21 000 уникальных relative paths и исключил один `.gitignore`-каталог; errors=0.
Fixture включает Unicode и файлы без расширения. Symlink/junction, исчезновение,
access narrowing и quoting/multiline дополнительно покрыты regression suite задачи.

## Плохо сжимаемые metadata

Профиль `300000 --entropy high` завершился ожидаемым bounded failure за 11,802 s:
`Closed ZIP part would exceed configured cap 8388608 bytes`. Peak RSS 128 118 784 B,
heap 43 803 424 B, scratch 55 474 479 B. Ни одной partial/ready части опубликовано
не было (`partialArtifacts: 0`). Это намеренный v1 контракт: закрытый ZIP не выходит
за cap; сложного повторного разбиения по фактическому коэффициенту сжатия нет.

Числа — одиночные локальные измерения, не SLA сети или ChatGPT. Целевой live size
ladder и архив около 5,53 MB проверяются отдельно.
