# Проверка 016: snapshot с default tree и явным stable

Работайте с synthetic sample-source. Для новой поставки используйте отдельную
папку и сохраните прежнюю конфигурацию. Не запускайте два процесса с одним scratch
или tunnel. После изменения config нужен restart; Check использует отдельный
временный scratch, поэтому не проверяет reuse рабочих jobs.

1. Оставьте `"snapshotFormat": "tree"` или удалите это поле из config.json.
   Старое boolean `experimentalSnapshotTree` можно удалить: оно игнорируется.
   Запустите Check.ps1: ожидаются LOCAL_MCP_PASS, snapshotFormat=tree и 13 tools,
   один snapshot, без snapshot_tree. Затем запустите комплект обычным способом.
2. В чате вызовите snapshot для sample-source, дождитесь job_status=completed,
   complete=true. Запишите jobId и artifact IDs. Получите manifest и все ZIP parts.
   Schema — filesystem-mcp.snapshot-tree-manifest, version=1, layout=tree-depth-v1.
   Каждый CSV начинается записью source root, затем header
   Type,Depth,Name,Length,LastWriteTime. Для полного индекса нужно получить все части.
3. Парсите RFC 4180 records, не физические строки. Числовая depth=0 означает детей
   root. D/F — каталог/файл; C восстанавливает предков в начале части; U означает
   неполный каталог. C/U не считаются объектами. Сохраняйте точные имена, включая
   запятые, кавычки и CR/LF. Проверяйте complete и exclusions перед выводом о пустоте.
4. Остановите комплект штатно. Задайте `"snapshotFormat": "stable"`, сохраните
   прежний scratch и limits, запустите Check и сервер заново. По-прежнему 13 tools;
   snapshot теперь выдаёт filesystem-mcp.snapshot-manifest, version=1, с прежними
   RootId,RelativePath,Name,Extension,Length,LastWriteTime. Для того же path новая
   stable job должна иметь иной ID. Не используйте tree idempotencyKey в stable.
5. Через job_status/get_artifact прочитайте tree job из шага 2 и сравните bytes.
   Смена только формата не закрывает старые результаты. После возврата к tree
   обычный snapshot может переиспользовать прежнюю complete job в пределах
   maxAgeMs и TTL. Reuse не продлевает TTL; отмена общей job затрагивает всех.
6. На копии config проверьте `"snapshotFormat": "csv"`, false и null: Check должен
   отказать до запуска MCP с ошибкой snapshotFormat. Верните рабочее значение.
   Глобальные FS_* переменные не меняйте: portable использует только config.

Локальный Verify.mjs автоматически проверяет эти режимы и смену формата после
restart с synthetic jobs, SHA-256/CRC и inherited environment. Он не доказывает
материализацию artifacts в ChatGPT; это подтверждается отдельно в шагах выше.
