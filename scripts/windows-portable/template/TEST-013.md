# Проверка 013: машина и тома источников

В этой сборке list_roots возвращает host (имя и системный UUID машины с MCP)
и rootDetails (путь, метка и серийный номер тома). Новые snapshot/bundle manifest
содержат provenance. Недоступное поле — null; серийный номер тома имеет формат
XXXX-XXXX. Старые jobs/manifests могут не содержать provenance.

## Обновление и запуск

1. Остановите прежний Start.ps1 через Ctrl+C и дождитесь выхода. Сохраните прежнюю
   папку, config.json и data/jobs. Распакуйте новый комплект в отдельную папку.
2. Перенесите tunnelId, roots и limits в новый config.json. Проверьте пути:
   относительные roots/scratchDirectory считаются от новой папки. Для малого
   опыта оставьте или добавьте ./sample-source с готовым hello.txt.
   Настройка нескольких локальных/сетевых roots описана в README.md / README.html.
3. Из папки нового комплекта выполните:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Check.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Start.ps1
   ```

   Ожидается LOCAL_MCP_PASS; runtime key вводится скрыто. Используйте прежнее
   подключение к туннелю по инструкции README, обновив discovery tools при
   необходимости. Две копии не должны одновременно использовать один tunnel/scratch.

Для сохранения старых jobs перенесите scratch целиком после остановки обоих
процессов, затем укажите этот scratch в новом config.json. Для малого опыта
перенос jobs не требуется. Не запускайте две копии на одном рабочем scratch.

## Проверка list_roots

Отправьте ChatGPT:

```text
Вызови list_roots. Покажи фактические roots, host и rootDetails.
Для каждого root укажи volume.label и volume.serialNumber, включая null.
Не подставляй идентификаторы по имени машины, пути или букве диска.
Не создавай snapshot большого дерева: сейчас проверяем только метаданные.
```

Имя должно относиться к машине с MCP-сервисом. Сверить его и системный UUID
можно в PowerShell на этой машине под той же учётной записью:

```powershell
hostname
(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID
```

Для доступного локального или подключённого сетевого диска номер/метку тома
можно сравнить с vol, например для Z: — `cmd /c vol Z:`. Выбирайте фактическую
букву своего диска. Для UNC без буквы пробуем только данные, доступные provider;
отсутствие значения допустимо. Нулевой/невалидный UUID превращается в null.
Два корня одного тома могут иметь одинаковые label/serial. Повышать права ради
заполнения полей не требуется. Клоны и аппаратные серийные номера не проверяются.

## Новые manifest

Выберите в list_roots корень sample-source. Отправьте:

```text
Для корня sample-source создай новый snapshot: forceRefresh=true и новый
уникальный idempotencyKey. Дождись completed через job_status, получи manifest
и ZIP через get_artifact. Проверь SHA-256, распаковку и поле provenance manifest.
Покажи jobId, provenance.host и provenance.root; путь должен быть фактическим
source snapshot, а метаданные — соответствовать только что проверенной машине/тому.
```

Затем:

```text
Создай bundle из того же sample-source с единственным файлом hello.txt
и новым уникальным idempotencyKey. Получи manifest и ZIP, проверь SHA-256 и
байты hello.txt. Проверь provenance.host и provenance.root в manifest.
Сохрани jobId, manifest artifactId и его SHA-256 для следующего шага.
```

Ожидается completed и provenance в обоих новых manifest. Недоступные поля остаются
null и не делают job неуспешной. Для своих корней выбирайте небольшой synthetic
каталог/файл, а не полный индекс диска. При смене машины/тома между вызовами
сведения могут отличаться: manifest хранит значение на момент начала своей job.

## Перезапуск и прежние результаты

Сохраните jobId, artifactId и SHA-256 нового manifest. Остановите Start.ps1,
снова запустите из той же папки с тем же scratch. Попросите ChatGPT выполнить
job_status старого jobId и get_artifact старого artifactId, без нового snapshot.
Provenance и SHA-256 manifest должны сохраниться. Старые результаты до 013
могут остаться без provenance: при чтении оно не дописывается.

## Отчёт

Достаточно BUILD.json sourceCommit, результата list_roots для local/network roots
(совпало / null / расхождение), результата обоих новых manifest и restart,
штатного выхода по Ctrl+C. Для расхождения нужны фактические аргументы и ответы.
Реальные machine UUID/volume serial, пути и ключи не публикуйте в Git-отчёте;
для приёмки обычно достаточно флагов доступности и совпадения.
