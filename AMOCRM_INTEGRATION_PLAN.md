# План интеграции с amoCRM API

> Составлен на основе официальной документации https://www.amocrm.ru/developers/  
> Дата: апрель 2026

---

## Содержание

1. [Регистрация интеграции](#1-регистрация-интеграции)
2. [OAuth 2.0 авторизация](#2-oauth-20-авторизация)
3. [Управление токенами](#3-управление-токенами)
4. [Подключение к API](#4-подключение-к-api)
5. [Работа с воронками и этапами](#5-работа-с-воронками-и-этапами)
6. [Работа с кастомными полями](#6-работа-с-кастомными-полями)
7. [Создание сделки с контактом](#7-создание-сделки-с-контактом)
8. [Работа с контактами и компаниями](#8-работа-с-контактами-и-компаниями)
9. [Задачи и примечания](#9-задачи-и-примечания)
10. [Вебхуки (входящие события)](#10-вебхуки-входящие-события)
11. [Звонки и источники](#11-звонки-и-источники)
12. [Rate limits и обработка ошибок](#12-rate-limits-и-обработка-ошибок)
13. [Требования к виджету для публикации](#13-требования-к-виджету-для-публикации)
14. [Чеклист запуска](#14-чеклист-запуска)

---

## 1. Регистрация интеграции

### Шаг 1.1 — Создать аккаунт разработчика

Зайти в любой аккаунт amoCRM → **Настройки → Интеграции → Создать интеграцию**.

### Шаг 1.2 — Заполнить карточку интеграции

| Поле | Описание |
|---|---|
| Название | Отображается пользователям |
| Описание | Кратко — что делает интеграция |
| Redirect URI | URL, на который amoCRM редиректит после авторизации (только HTTPS) |
| Scopes | `crm` (обязательно), `notifications` (для вебхуков) |
| Тип | `Приватная` (для одного аккаунта) или `Публичная` (маркетплейс) |

### Шаг 1.3 — Получить учётные данные

После создания amoCRM выдаёт:
- **Integration ID** (`client_id`) — UUID интеграции
- **Secret key** (`client_secret`) — хранить только на сервере, никогда в клиентском коде

Сохрани оба значения в `.env` файл:
```env
AMOCRM_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AMOCRM_CLIENT_SECRET=xxxxxxxxxxxx
AMOCRM_REDIRECT_URI=https://your-domain.com/oauth/callback
```

---

## 2. OAuth 2.0 авторизация

### Схема потока

```
Пользователь → amoCRM (подтверждение) → Redirect URI ?code=XXX → Твой сервер → POST /oauth2/access_token → access_token + refresh_token
```

### Шаг 2.1 — Кнопка OAuth (опционально, для UI)

Подключить готовый виджет кнопки:
```html
<script src="https://www.amocrm.ru/auth/button.min.js"></script>
<div class="amocrm_oauth"
  data-client-id="ТВОЙ_CLIENT_ID"
  data-redirect_uri="https://your-domain.com/oauth/callback"
  data-scopes="crm,notifications"
  data-title="Подключить amoCRM"
  data-color="blue"
  data-mode="popup">
</div>
```

### Шаг 2.2 — Получить authorization code

После авторизации пользователем amoCRM делает GET-редирект:
```
https://your-domain.com/oauth/callback?code=AUTH_CODE&state=STATE&referer=SUBDOMAIN
```

Сохрани `referer` — это субдомен аккаунта (`{referer}.amocrm.ru`). Он нужен для всех последующих запросов.

### Шаг 2.3 — Обменять code на токены

```http
POST https://{subdomain}.amocrm.ru/oauth2/access_token
Content-Type: application/json

{
  "client_id": "AMOCRM_CLIENT_ID",
  "client_secret": "AMOCRM_CLIENT_SECRET",
  "grant_type": "authorization_code",
  "code": "AUTH_CODE_ИЗ_РЕДИРЕКТА",
  "redirect_uri": "https://your-domain.com/oauth/callback"
}
```

**Ответ:**
```json
{
  "token_type": "Bearer",
  "expires_in": 86400,
  "access_token": "eyJ0...",
  "refresh_token": "def50200..."
}
```

> **Важно:** Код действителен **20 минут**. Обменять нужно сразу.

---

## 3. Управление токенами

### Сроки жизни

| Токен | Срок | Примечания |
|---|---|---|
| `access_token` | 24 часа | Используется в заголовке Authorization |
| `refresh_token` | 3 месяца | Одноразовый — при использовании выдаётся новая пара |

### Шаг 3.1 — Хранение токенов

Хранить в базе данных или защищённом хранилище. Структура записи:
```json
{
  "subdomain": "myfirm",
  "access_token": "eyJ0...",
  "refresh_token": "def50200...",
  "expires_at": 1751707200
}
```

### Шаг 3.2 — Обновление access_token

До истечения (или при 401) вызвать:
```http
POST https://{subdomain}.amocrm.ru/oauth2/access_token
Content-Type: application/json

{
  "client_id": "AMOCRM_CLIENT_ID",
  "client_secret": "AMOCRM_CLIENT_SECRET",
  "grant_type": "refresh_token",
  "refresh_token": "ТЕКУЩИЙ_REFRESH_TOKEN",
  "redirect_uri": "https://your-domain.com/oauth/callback"
}
```

В ответе — новые `access_token` и `refresh_token`. Старый refresh немедленно аннулируется.

### Шаг 3.3 — Логика автообновления в коде

```typescript
async function getValidToken(accountId: string): Promise<string> {
  const token = await db.getToken(accountId);
  if (Date.now() / 1000 > token.expires_at - 300) {
    // Обновляем за 5 минут до истечения
    return await refreshToken(token);
  }
  return token.access_token;
}
```

---

## 4. Подключение к API

### Базовый URL

Все запросы к API идут на:
```
https://{subdomain}.amocrm.ru/api/v4/...
```

Субдомен (`{subdomain}`) — уникален для каждого аккаунта. Получается из `referer` при OAuth.

### Заголовки каждого запроса

```http
Authorization: Bearer {access_token}
Content-Type: application/json
```

### Шаг 4.1 — Проверить соединение

```http
GET https://{subdomain}.amocrm.ru/api/v4/account
Authorization: Bearer {access_token}
```

**Ответ:** данные аккаунта (ID, название, subdomain, часовой пояс и т.д.)

---

## 5. Работа с воронками и этапами

### Шаг 5.1 — Получить список воронок

```http
GET https://{subdomain}.amocrm.ru/api/v4/leads/pipelines
```

**Ответ:** массив воронок с вложенными статусами.

```json
{
  "_embedded": {
    "pipelines": [
      {
        "id": 1,
        "name": "Основная воронка",
        "is_main": true,
        "_embedded": {
          "statuses": [
            {"id": 10, "name": "Новая заявка", "sort": 10, "type": 0},
            {"id": 142, "name": "Успешно реализовано", "type": 1},
            {"id": 143, "name": "Закрыто и не реализовано", "type": 2}
          ]
        }
      }
    ]
  }
}
```

> **Системные статусы:** ID 142 (выиграна) и 143 (проиграна) — неудаляемые.

### Шаг 5.2 — Создать воронку (если нужна)

```http
POST https://{subdomain}.amocrm.ru/api/v4/leads/pipelines
Content-Type: application/json

[
  {
    "name": "HR Скоринг",
    "sort": 10,
    "is_main": false,
    "_embedded": {
      "statuses": [
        {"name": "Новая заявка", "sort": 10, "color": "#99ccff"},
        {"name": "Скоринг", "sort": 20, "color": "#ffcc99"},
        {"name": "Интервью", "sort": 30, "color": "#99ff99"},
        {"name": "Оффер", "sort": 40, "color": "#cc99ff"}
      ]
    }
  }
]
```

> Максимум **50 воронок** и **100 статусов** на аккаунт.

---

## 6. Работа с кастомными полями

### Шаг 6.1 — Получить существующие поля

```http
GET https://{subdomain}.amocrm.ru/api/v4/leads/custom_fields
GET https://{subdomain}.amocrm.ru/api/v4/contacts/custom_fields
```

### Шаг 6.2 — Создать кастомные поля

```http
POST https://{subdomain}.amocrm.ru/api/v4/leads/custom_fields
Content-Type: application/json

[
  {
    "name": "Скоринг балл",
    "type": "numeric",
    "sort": 10
  },
  {
    "name": "Источник резюме",
    "type": "select",
    "sort": 20,
    "enums": [
      {"value": "hh.ru", "sort": 1},
      {"value": "Telegram", "sort": 2},
      {"value": "Прямой контакт", "sort": 3}
    ]
  },
  {
    "name": "Комментарий HR",
    "type": "textarea",
    "sort": 30
  }
]
```

### Типы полей

| Тип | Описание |
|---|---|
| `text` | Строка |
| `numeric` | Число |
| `checkbox` | Да/Нет |
| `select` | Один из вариантов |
| `multiselect` | Несколько вариантов |
| `date` | Дата (Unix timestamp) |
| `date_time` | Дата и время |
| `textarea` | Многострочный текст |
| `url` | Ссылка |
| `email` | Email с типом (WORK/PERSONAL) |
| `phone` | Телефон с типом (WORK/MOBILE и т.д.) |
| `file` | Файл |

### Шаг 6.3 — Сохранить ID полей

После создания сохранить маппинг ID полей:
```typescript
const FIELD_IDS = {
  score: 123,          // Скоринг балл
  source: 124,         // Источник резюме
  hrComment: 125,      // Комментарий HR
  resumeUrl: 126,      // Ссылка на резюме
};
```

---

## 7. Создание сделки с контактом

### Шаг 7.1 — Комплексное создание через `/leads/complex`

Один запрос создаёт сделку + контакт + компанию:

```http
POST https://{subdomain}.amocrm.ru/api/v4/leads/complex
Content-Type: application/json

[
  {
    "name": "Кандидат: Иванов Иван — Backend Developer",
    "pipeline_id": 1,
    "status_id": 10,
    "responsible_user_id": 456,
    "price": 0,
    "custom_fields_values": [
      {
        "field_id": 123,
        "values": [{"value": 85}]
      },
      {
        "field_id": 124,
        "values": [{"enum_id": 1}]
      },
      {
        "field_id": 125,
        "values": [{"value": "Отличный кандидат, опыт 5 лет"}]
      }
    ],
    "_embedded": {
      "tags": [{"name": "backend"}, {"name": "senior"}],
      "contacts": [
        {
          "first_name": "Иван",
          "last_name": "Иванов",
          "responsible_user_id": 456,
          "custom_fields_values": [
            {
              "field_code": "PHONE",
              "values": [{"value": "+79991234567", "enum_code": "WORK"}]
            },
            {
              "field_code": "EMAIL",
              "values": [{"value": "ivan@example.com", "enum_code": "WORK"}]
            }
          ]
        }
      ]
    }
  }
]
```

**Ответ:**
```json
[
  {
    "id": 5001,
    "contact_id": 301,
    "company_id": null,
    "merged": false,
    "request_id": []
  }
]
```

> Лимит: **50 сделок** за запрос, **40 кастомных полей** на каждую сущность.

### Шаг 7.2 — Обновить статус сделки

```http
PATCH https://{subdomain}.amocrm.ru/api/v4/leads/5001
Content-Type: application/json

{
  "status_id": 20,
  "pipeline_id": 1
}
```

---

## 8. Работа с контактами и компаниями

### Поиск контакта по телефону или email

```http
GET https://{subdomain}.amocrm.ru/api/v4/contacts?query=+79991234567&with=leads
```

### Создание/обновление контакта

```http
POST https://{subdomain}.amocrm.ru/api/v4/contacts
Content-Type: application/json

[
  {
    "name": "Иван Иванов",
    "responsible_user_id": 123,
    "custom_fields_values": [
      {"field_code": "PHONE", "values": [{"value": "+79991234567", "enum_code": "WORK"}]},
      {"field_code": "EMAIL", "values": [{"value": "ivan@example.com", "enum_code": "WORK"}]}
    ]
  }
]
```

### Enum-коды для phone/email

| Код | Описание |
|---|---|
| `WORK` | Рабочий |
| `WORKDD` | Рабочий прямой |
| `MOB` | Мобильный |
| `FAX` | Факс |
| `HOME` | Домашний |
| `OTHER` | Другой |

---

## 9. Задачи и примечания

### Создание задачи

```http
POST https://{subdomain}.amocrm.ru/api/v4/tasks
Content-Type: application/json

[
  {
    "text": "Позвонить кандидату для назначения интервью",
    "complete_till": 1751707200,
    "task_type_id": 1,
    "responsible_user_id": 123,
    "entity_id": 5001,
    "entity_type": "leads"
  }
]
```

| `task_type_id` | Тип |
|---|---|
| 1 | Звонок |
| 2 | Встреча |

### Добавление примечания к сделке

```http
POST https://{subdomain}.amocrm.ru/api/v4/leads/notes
Content-Type: application/json

[
  {
    "entity_id": 5001,
    "note_type": "common",
    "params": {
      "text": "Кандидат прошёл скоринг с баллом 85/100. Рекомендован к интервью."
    }
  }
]
```

---

## 10. Вебхуки (входящие события)

### Шаг 10.1 — Настроить endpoint

Создать публичный HTTPS-эндпоинт на своём сервере, который:
- Принимает `POST` запросы
- Парсит тело в формате `application/x-www-form-urlencoded`
- Отвечает любым 2xx кодом **в течение 2 секунд**

### Шаг 10.2 — Подписаться на события

В amoCRM: **Настройки → Интеграции → Твоя интеграция → Webhooks**

Или при создании интеграции указать URL и события.

### Шаг 10.3 — Обрабатывать входящие webhook

amoCRM отправляет POST с телом вида:
```
leads[status][0][id]=5001&leads[status][0][status_id]=20&...
```

Пример парсинга на Node.js:
```typescript
import qs from 'qs';

app.post('/webhook', (req, res) => {
  const data = qs.parse(req.body);
  
  if (data.leads?.status) {
    for (const lead of Object.values(data.leads.status)) {
      console.log(`Сделка ${lead.id} перешла в статус ${lead.status_id}`);
      // обработка...
    }
  }
  
  res.sendStatus(200);
});
```

### Поддерживаемые события

| Сущность | События |
|---|---|
| `leads` | `add`, `update`, `delete`, `status`, `responsible` |
| `contacts` | `add`, `update`, `delete`, `responsible` |
| `companies` | `add`, `update`, `delete`, `responsible` |
| `tasks` | `add`, `update`, `delete` |

### Логика повторных доставок

| Попытка | Задержка |
|---|---|
| 1-я | через 5 мин |
| 2-я | через 15 мин |
| 3-я | через 15 мин |
| 4-я | через 1 час |

> При 100+ невалидных откликах за 2 часа — хук отключается автоматически.

---

## 11. Звонки и источники

### Создание источника (для группировки заявок)

```http
POST https://{subdomain}.amocrm.ru/api/v4/sources
Content-Type: application/json

[
  {
    "name": "HR Scoring Widget",
    "external_id": "hr-scoring-widget-v1",
    "pipeline_id": 1
  }
]
```

Лимит: **100 активных источников** на интеграцию.

### Регистрация входящего звонка

```http
POST https://{subdomain}.amocrm.ru/api/v4/calls
Content-Type: application/json

[
  {
    "direction": "inbound",
    "duration": 180,
    "source": "HR Scoring Widget",
    "phone": "+79991234567",
    "call_status": 4,
    "call_result": "Успешный контакт",
    "link": "https://storage.example.com/calls/recording.mp3"
  }
]
```

| `call_status` | Значение |
|---|---|
| 1 | Оставил сообщение |
| 2 | Перезвонить позже |
| 3 | Недозвон |
| 4 | Переговоры состоялись |
| 5 | Неверный номер |
| 6 | Отказ от переговоров |
| 7 | Недоступен |

---

## 12. Rate limits и обработка ошибок

### Ограничения API

| Параметр | Лимит |
|---|---|
| Запросов на интеграцию | **7 в секунду** |
| Запросов на аккаунт | **50 в секунду** |
| Записей в одном GET | **250** (max) |
| Записей в одном POST/PATCH | **250** (рекомендуется ≤ 50) |
| Сделок в `/leads/complex` | **50** |

### HTTP-коды и реакция

| Код | Причина | Действие |
|---|---|---|
| 200/201 | Успех | — |
| 204 | Не найдено | Проверить ID |
| 400 | Некорректные данные | Проверить тело запроса |
| 401 | Токен истёк/неверный | Обновить токен |
| 402 | Аккаунт не оплачен | Уведомить пользователя |
| 403 | Нет прав | Проверить scopes и права пользователя |
| 429 | Rate limit | Пауза + повтор с backoff |
| 504 | Таймаут | Уменьшить размер пакета |

### Паттерн retry с exponential backoff

```typescript
async function apiRequest(fn: () => Promise<any>, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429) {
        await sleep(Math.pow(2, i) * 1000); // 1s, 2s, 4s
        continue;
      }
      if (err.status === 401 && i === 0) {
        await refreshToken();
        continue;
      }
      throw err;
    }
  }
}
```

---

## 13. Требования к виджету для публикации

> Актуально только при публикации в амоМаркет. Приватные интеграции модерацию не проходят.

### Обязательная структура архива

```
widget.zip
├── manifest.json
├── i18n/
│   ├── ru.json
│   └── en.json
└── images/
    ├── logo.png        (512×512)
    ├── logo_main.png
    ├── logo_medium.png
    ├── logo_min.png
    └── logo_small.png
```

### Технические запреты

- `eval()` — запрещён
- `alert()`, `confirm()` — запрещены
- Глобальные CSS-стили — запрещены
- Синхронные AJAX-запросы — запрещены
- Виджет не должен перекрывать элементы интерфейса amoCRM

### Обязательные требования

- Политика конфиденциальности с реквизитами компании
- Пользователь может отключить интеграцию в любой момент
- Нельзя запрашивать учётные данные amoCRM у клиентов напрямую

### Этапы модерации (5 шагов)

1. Проверка карточки виджета
2. Аудит кода
3. Проверка описания
4. Тест в интерфейсе amoCRM
5. Публикация

---

## 14. Чеклист запуска

### Подготовка

- [ ] Создана интеграция в amoCRM, получены `client_id` и `client_secret`
- [ ] `client_secret` хранится только на сервере (не в клиентском коде)
- [ ] HTTPS настроен на сервере
- [ ] `redirect_uri` добавлен в интеграцию

### OAuth

- [ ] Реализован обработчик callback (`/oauth/callback`)
- [ ] `code` обменивается на токены в течение 20 минут
- [ ] `subdomain` сохраняется из параметра `referer`
- [ ] Токены сохраняются в БД с временем истечения

### Работа с токенами

- [ ] Реализовано автообновление `access_token` через `refresh_token`
- [ ] Новая пара токенов сохраняется при каждом обновлении
- [ ] При ошибке 401 запускается refresh, а не повторная авторизация

### Работа с API

- [ ] Получены и сохранены ID воронок и статусов
- [ ] Созданы и сохранены ID кастомных полей
- [ ] Реализована обработка rate limit (429 → backoff)
- [ ] Реализована обработка 504 (уменьшение пакета)

### Вебхуки (если используются)

- [ ] Endpoint доступен публично по HTTPS
- [ ] Ответ отдаётся в течение 2 секунд
- [ ] Реализована идемпотентная обработка (дублей не должно быть)
- [ ] Подписка на нужные события настроена в amoCRM

### Перед релизом

- [ ] Все секреты убраны из кода и логов
- [ ] Реализовано логирование ошибок
- [ ] Протестирована повторная OAuth-авторизация (ситуация истёкшего refresh)
- [ ] Протестирован сценарий удаления интеграции пользователем

---

## Полезные ссылки

| Ресурс | URL |
|---|---|
| Документация | https://www.amocrm.ru/developers/ |
| OAuth — обзор | https://www.amocrm.ru/developers/content/oauth/oauth |
| OAuth — пошагово | https://www.amocrm.ru/developers/content/oauth/step-by-step |
| API сделок | https://www.amocrm.ru/developers/content/crm_platform/leads-api |
| API контактов | https://www.amocrm.ru/developers/content/crm_platform/contacts-api |
| Кастомные поля | https://www.amocrm.ru/developers/content/crm_platform/custom-fields |
| Вебхуки | https://www.amocrm.ru/developers/content/crm_platform/webhooks |
| Коды ошибок | https://www.amocrm.ru/developers/content/crm_platform/error-codes |
| Требования к виджетам | https://www.amocrm.ru/developers/content/integrations/requirements |
