# 020: необязательный runtime key в portable config

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятые 017–019 и portable от 30.10.

## Зачем

Пользователь хочет запускать portable без повторного ввода runtime API key.
Непустой ключ в настройках используется при запуске; пустое или отсутствующее
поле сохраняет прежний скрытый ввод без записи введённого значения.

## Scope и контракт

- Optional top-level `runtimeApiKey` в portable `config.json`, template — пустая
  строка. Отсутствие, null, пустая или whitespace-only строка вызывают prompt.
  Непустая строка после trim используется без prompt; иные JSON-типы отклоняются.
- Ключ хранится в пользовательском config обычным текстом. Пользователь явно
  разрешил этот режим. Интерактивный ввод не сохраняется в config.
- Tunnel получает ключ через прежний `CONTROL_PLANE_API_KEY`, профиль — только
  env-reference. Не добавлять ключ в argv, output, diagnostics или MCP config.
  Ошибка авторизации сохранённого ключа остаётся обычной ошибкой tunnel-client;
  автоматической перезаписи config или второго prompt после неё нет.
- Start.ps1, config helper, template, Verify и операторские docs входят в scope.
  Скрыть содержимое malformed JSON в diagnostics, поскольку config теперь может
  содержать ключ. Не менять source tools, guard, dependencies и runtime pins.
- Проверки только synthetic. Новый чистый portable собирается отдельно;
  установленный сервис/рабочий туннель не перенастраивать.

## Acceptance

- [ ] Непустой настроенный ключ используется без Read-Host; старые конфиги и
      пустые/null/whitespace значения сохраняют скрытый ввод без сохранения.
- [ ] Неверные типы и malformed JSON отклоняются без утечки synthetic sentinel.
- [ ] Key отсутствует в exported configuration, профиль содержит env-reference;
      success/error cleanup освобождает lock и переменную окружения.
- [ ] Полный repository check и расширенный portable Verify проходят; новая
      чистая поставка содержит пустой ключ и проверенные hashes.
- [ ] Документация и Work record объясняют контракт, проверки и ограничения.

## Work record

Назначение: текущий planning-чат выполняет узкую задачу в отдельном worktree;
branch `codex/020-portable-runtime-key`. Base до карточки — `46ced0c2`.
Реализация и проверки ещё не начаты.
