# BLACK X Bot

بوت مستقل باسم `black-x-bot` مبني بـ **Node.js 20 (‎20.12+) وdiscord.js v14 وESM**. يخدم [سيرفر BLACK X الرسمي](https://discord.gg/RefwFbFnQw) فقط (كود الدعوة `RefwFbFnQw`). أوامر السلاش مسجّلة على السيرفر، وواجهة الرولات مخصصة لخادم الموقع؛ الموقع لا يحتاج إلى توكن البوت.

## ١. إضافة البوت إلى Discord

1. افتح [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** واكتب `BLACK X Bot`. انسخ **Application ID** من **General Information**.
2. في **Bot** اضغط **Reset Token** واحفظه محليًا في `.env` أو في مدير الأسرار فقط. أطفئ **Requires OAuth2 Code Grant**، وأطفئ **Public Bot** إذا كنت لا تريد أن يضيفه أحد غيرك. إن منعك Discord من إطفاء **Public Bot** بسبب رابط التثبيت الافتراضي، اختر **Installation → Install Link → None** أولًا. البوت يستخدم `Guilds` افتراضيًا؛ الصوت وAutoMod اختياريان بدون Privileged Intents. **Server Members Intent** مطلوب لحصر فريق الدعم في تنبيهات الشكاوى بالخاص أو للترحيب الاختياري. مش مطلوب لو هتكتفي بصندوق الفريق وتنبيه المالك. **Message Content Intent** مش مطلوب.
3. استبدل `CLIENT_ID` بـ **Application ID** في الرابط التالي. افتحه بحساب مخوّل بإضافة التطبيقات واختر **السيرفر الرسمي فقط**:

   ```text
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=268520464
   ```

   الرابط يطلب `View Channel` و`Send Messages` و`Read Message History` و`Embed Links` و`Manage Channels` و`Manage Roles`. `Manage Webhooks` اختياري للويب هوكات الأصلية فقط، ويفضّل منحه في الرومات اللي محتاجاه. لإعداد أول مرة بالويب هوكات يمكن استخدام `permissions=805391376`، ثم حصرها في الرومات. لو البوت موجود، عدّل صلاحيات روله بدل إعادة دعوته. لا تعطِه `Administrator` أو `Kick/Ban`. راجع [خريطة الصلاحيات](docs/server-design.md#رول-البوت-وصلاحياته).
4. من **Server Settings → Widget → Enable Server Widget** انسخ **Server ID** الظاهر في الإعدادات أو المعرّف في رابط Widget API. يمكنك إطفاء الـ Widget بعد النسخ. البديل: فعّل **User Settings → Advanced → Developer Mode**، ثم اضغط بزر الفأرة الأيمن على أيقونة السيرفر → **Copy Server ID**. انسخ أيضًا **User ID** لمالك السيرفر الفعلي باستخدام **Copy User ID**.
5. من **Server Settings → Roles** حرّك رول البوت فوق رولات المنتج اللي بيديرها (VIP وCreator) ورولات الوصول اللي هيستخدمها التجهيز. خلّي رولات الإدارة بصلاحيات عامة أعلى منه؛ دور دعم بسيط يكفي للتذاكر. البوت لا يرفع روله بنفسه.

## ٢. تشغيل محلي

```bash
cp -n .env.example .env
chmod 600 .env
# افتح .env محليًا واملأ القيم المطلوبة.
npm ci
npm run register
npm start
```

| المتغير | القيمة |
|---|---|
| `DISCORD_BOT_TOKEN` | توكن **Bot** من الـ Portal، لا `Client Secret`. |
| `DISCORD_GUILD_ID` | معرّف السيرفر الرسمي الوحيد. `ALLOWED_GUILD_ID` اسم بديل اختياري؛ إذا عرّفت الاثنين فلا بد أن يتطابقا. كود الدعوة ليس Guild ID. |
| `BX_OWNER_DISCORD_ID` | معرّف حساب مالك السيرفر الفعلي. |
| `BOT_API_SECRET` | سر مستقل بين خادم الموقع والبوت. استخدم قيمة عشوائية قوية، مثل 32 بايت بصيغة hex. |
| `PORT` | اختياري؛ الافتراضي `8080`. |

لتوليد سر من غير طباعته على الشاشة:

```bash
umask 077
mkdir -p secrets
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > secrets/bot-api-secret
```

ضع قيمة الملف محليًا في `BOT_API_SECRET` وفي إعدادات **خادم** الموقع. لا تضعها في JavaScript المتصفح أو Git أو الشات. يأخذ التطبيق القيم من متغيرات البيئة (مثل Secrets في الاستضافة) أو من `.env` محليًا؛ القيم المصدّرة في البيئة لها الأولوية. `.env` و`secrets/` مستبعدان من Git ومن سياق النشر.

`npm run register` يسجّل الأوامر فقط ويخرج. `npm start` يعيد تسجيلها تلقائيًا على نفس السيرفر ثم يشغّل الـ Gateway وHTTP. لو دخل البوت سيرفرًا آخر، يرفض أوامره ويحاول مغادرته.

## ٣. استخدام الأوامر

- `/setup dry_run:true` لمراجعة الخطة من غير أي `POST` أو `PATCH` أو `DELETE`، ثم `/setup` للتنفيذ. الأمر للمالك الفعلي فقط، ويجب أن يطابق `BX_OWNER_DISCORD_ID` ويملك صلاحية `Manage Server` في Discord.
- `/announce room:updates title:تحديث body:التفاصيل url:https://example.com` ينشر Embed بلون الروم. الرابط اختياري (`http` أو `https`). الوصف لا يتجاوز 3800 حرف. يرفض البوت التوكنات المعروفة وروابط الويب هوك داخل الإعلان، والمنشن لا يرسل تنبيهًا، حتى لو النص فيه `@everyone` أو منشن لرول. للمالك المضبوط أو مشرف عنده `Manage Messages` في الروم المقصود؛ المشرف لا يحتاج إذن كتابة في روم القراءة فقط.
- `/role grant user:@عضو role:vip_basic` و`/role revoke user:@عضو role:vip_basic` للمالك المضبوط أو مشرف لديه `Manage Roles` ورول أعلى من الرول المطلوب. البوت نفسه يجب أن يكون فوق الرول. لا يعطي البوت رولًا تغيّرت صلاحياته عن `View Channel` فقط.
- `/status` يعرض الكاتيجوري والرومات والرولات والويب هوكات، وعدد الأعضاء، وترتيب أعلى رول للبوت، والصلاحيات الناقصة على مستوى السيرفر وفي الرومات. فرّق بين «الويب هوك غير موجود» و«تعذّر فحصه»؛ الثانية تعني أن Discord رفض القراءة أو لم يستجب.

كل ردود الأوامر **ephemeral** وبالعربي. الإعلان نفسه يُنشر في الروم المختار.

### ميزات المجتمع والركن الإسلامي

`/arena` تحديات الأنمي، `/party` حفلات مشاهدة، `/follow` تنبيهات الحلقات، `/recommend` ترشيحات BLACK Z من الكتالوج، و`/adhkar`، `/prayer`، `/daily`، `/ramadan`، `/seerah`. راجع [الأوامر والتخزين وعقد تكامل الكتالوج والحلقات](docs/community.md). الجدولة والمتابعات وترتيب الأسبوع تحتاج Turso Cloud (`TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`) أو PostgreSQL (`DATABASE_URL`). اضبط القيم في Config Vars لتطبيق البوت على Heroku فقط. الميزات الأصلية تفضل متاحة من غير قاعدة بيانات.

### أدوات إدارة BLACK X (اختيارية)

التذاكر الخاصة، صندوق الفريق وسجله، المراجعات والاستئناف، أجندة الفعاليات والانتظار وإدارة الوصول المؤقت. راجع [دليل التفعيل والصلاحيات والأوامر الـ٢٨](docs/administration.md). الأدوات لا تنفّذ تغييرات لمجرد تسجيل الأوامر؛ المالك يفعّلها ويضبط النطاق. `/announce preview:true` يفتح معاينة خاصة، و`/status integration:true` يبيّن استقبال الكتالوج دون تشغيل مزامنة.

[تصميم سيرفر BLACK X ورول البوت](docs/server-design.md) · [تجهيز الرومات والقوانين واستقبال الشكاوى](docs/server-prepare.md): أمر `/server prepare` للمالك يعرض الأذونات قبل التطبيق، ويجهّز لوحة الشكاوى الخاصة وصندوق الفريق. القوانين تتعدّل في نفس الرسالة بـ`/rules`.

### الترحيب والربط بين حساب الموقع وديسكورد

[دليل الترحيب وDiscord Onboarding وربط `/profile`](docs/site-bridge.md): `/welcome` يضبط رسالة المالك ولينكات حساباته ويعاينها قبل التفعيل. أسئلة الدخول من إعداد Discord نفسه. جسر الموقع اختياري وبيستخدم الحساب المرتبط والتذكرة الخاصة نفسها على الطرفين، بواجهة `/profile` تركب على تسجيل الدخول الموجود. لا يحتاج إعادة `/setup`.

### ما ينشئه `/setup`

ضمن كاتيجوري `🎮 BLACK X`:

| المفتاح | الروم | كتابة الأعضاء |
|---|---|---|
| `updates` | 📢-تحديثات-الموقع | قراءة فقط |
| `support` | 🛠️-الدعم-الفني | متاحة |
| `creators` | 🎬-صنّاع-المحتوى | متاحة |
| `offers` | 🎁-العروض-والخصومات | قراءة فقط |

دي الأذونات الابتدائية **للرومات الجديدة فقط**. في رومات القراءة فقط: `@everyone` له `allow=1024` و`deny=2048`، والبوت له `allow=3072` و`deny=0`. الأعضاء الذين لديهم `Administrator` أصلًا يتجاوزون overwrites بحكم Discord؛ البوت لا يمنح هذه الصلاحية.

| مفتاح الرول | الاسم | اللون |
|---|---|---|
| `vip_monarch` | 👑 · VIP Monarch | `#9B59B6` |
| `vip_basic` | 💠 · VIP Basic | `#3498DB` |
| `creator` | 🎬 · Creator معتمد | `#2ECC71` |

الرولات الثلاث مرئية منفصلة (`hoist=true`)، وغير قابلة للمنشن العام (`mentionable=false`)، و`permissions="1024"`. ترتيبها هو ترتيب الجدول مباشرة أسفل أعلى رول للبوت. إذا كانت الهرمية تمنع الترتيب، يكمل `/setup` الموارد الأخرى ويعرض تنبيهًا.

### تكرار الإعداد والويب هوكات

- مطابقة الروم بعلامة الـ topic مثل `[BLACK X · updates]` وليس بالاسم. الكاتيجوري والرولات تُطابق بالاسم افتراضيًا. معرّفات `DISCORD_CHANNEL_*` و`DISCORD_ROLE_*` في `.env` لها أولوية إذا كانت موارد صالحة في نفس السيرفر. لو الروم موجود، الإعداد يحافظ على اسمه ومكانه وأذوناته، ويضيف علامة الربط عند الحاجة فقط. لو سمّيت الكاتيجوري الأصلية باسم مختلف، ثبّت معرّفها في `DISCORD_CHANNEL_CATEGORY`.
- مع إذن `Manage Webhooks`، `/setup` يستخدم الـIncoming Webhook المضبوط لمعرف الروم، أو النسخة الوحيدة باسم `BLACK X Bot`. لو مفيش نسخة يقدر ينشئها. لو فيه أكتر من نسخة بالاسم من غير ID صالح، يطلب تثبيت **معرّف النسخة اللي التطبيق بيستخدمها**. مفيش حذف ولا تدوير تلقائي ولا تغيير لاسم ويب هوك موجود؛ الروابط الحالية تفضل كما هي. راجع واعتمد أي تنظيف يدوي بعد التأكد من المرسل اللي بيستخدم كل رابط.
- بلوك `DISCORD_*` في الرد يحتوي **معرّفات** لا توكنات. انسخ منه القيم غير الفارغة إلى `.env` وأعد تشغيل البوت. للحصول على الرابط العامل عند الحاجة: **Edit Channel → Integrations → Webhooks → BLACK X Bot → Copy Webhook URL**. خزّن الرابط كسر في التطبيق الذي سيرسل الإعلانات، وأرسل `allowed_mentions: { "parse": [] }` معه لمنع التنبيهات. `DISCORD_WEBHOOK_*` يقبل ID أو رابط Discord، لكن البوت يستخدم الـ ID فقط؛ الأفضل حفظ الـ ID للبوت وعدم مشاركة الرابط.

## ٤. تكامل خادم الموقع

أرسل `X-BX-Secret: <BOT_API_SECRET>` في كل الطلبات، بما فيها `/health`. الحد 60 طلبًا في الدقيقة لكل IP اتصال؛ لا يثق التطبيق في `X-Forwarded-For`، وبالتالي قد تتشارك الطلبات القادمة عبر نفس الوكيل العكسي الحد.

| الطريقة والمسار | الإدخال / النتيجة |
|---|---|
| `POST /api/roles/grant` | JSON: `{ "discordId": "…", "roleKey": "vip_monarch" }` |
| `POST /api/roles/revoke` | نفس JSON. النجاح يعيد `{ ok, discordId, roleKey, changed }`؛ `changed: false` يعني أن الحالة المطلوبة موجودة بالفعل. |
| `GET /api/roles/:discordId` | `{ ok, discordId, roles }`؛ `roles` قائمة مفاتيح من `vip_monarch` و`vip_basic` و`creator`. |
| `GET /health` | `{ ok, uptime, bot: { id, tag, ready }, guild: { id, memberCount } }`؛ `uptime` بالثواني. `503` إذا كان Gateway أو السيرفر غير جاهز. |

مثال من جهاز التشغيل بعد تحميل سر الموقع في متغير shell محليًا:

```bash
BX_URL=http://127.0.0.1:8080
MEMBER_DISCORD_ID=123456789012345678  # غيّره إلى معرّف عضو فعلي
curl -fsS "$BX_URL/health" -H "X-BX-Secret: $BOT_API_SECRET"
curl -fsS "$BX_URL/api/roles/grant" \
  -H "X-BX-Secret: $BOT_API_SECRET" -H 'Content-Type: application/json' \
  --data "{\"discordId\":\"$MEMBER_DISCORD_ID\",\"roleKey\":\"vip_basic\"}"
curl -fsS "$BX_URL/api/roles/$MEMBER_DISCORD_ID" -H "X-BX-Secret: $BOT_API_SECRET"
```

الأخطاء تعيد JSON فيه `ok: false` و`code` و`message`. الحالات: `400` طلب غير صالح، `401` سر ناقص أو خطأ، `403` هرمية أو صلاحية تمنع التعديل، `404` العضو ليس في السيرفر أو المسار غير معروف، `429` تجاوز الحد (مع `Retry-After`)، `502` رفض Discord أو تعذّر الوصول إليه أو غياب الرول المطلوب. كل طلب يُسجّل في JSON بالمسار المنطقي والحالة والوقت، بدون ترويسات أو أجسام طلبات أو توكنات. عميل Discord يحترم `retry_after`، ويعيد محاولة `5xx` حتى ثلاث مرات بـ backoff، ولا يعيد باقي أخطاء `4xx`.

## ٥. النشر

### Heroku عبر GitHub Actions

ده مسار النشر المعتمد للمشروع: **Deploy BLACK X to Heroku** على `main` يبني صورة Docker ويرفعها، والبوت يشتغل على **web dyno واحد من نوع Basic أو Standard** عشان يفضل متصلًا. استخدم تطبيق Heroku **Cedar** على stack `container`. متغيرات البوت الأساسية (وقاعدة البيانات الاختيارية) في **Heroku Config Vars**؛ GitHub يحتاج اسم التطبيق واعتماد نشر Heroku فقط. [دليل الإعداد والنشر خطوة بخطوة](docs/github-actions.md).

### Docker / VPS (بديل يدوي)

```bash
docker build -t black-x-bot .
docker run -d --name black-x-bot --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8080:8080 black-x-bot
```

الصورة `node:20-alpine` وتعمل كمستخدم غير root. الـ healthcheck يستدعي `/health` بالسر من البيئة بدون طباعته. لو خادم الموقع على جهاز آخر، مرّر HTTP عبر شبكة خاصة أو reverse proxy بـ TLS بدل كشف المنفذ للعامة. شغّل نسخة واحدة من البوت.

### Google Cloud Run (بديل يدوي)

اضبط الأسرار `discord-bot-token` و`black-x-api-secret` في **Secret Manager** داخل المشروع قبل النشر. اضبط الـ IDs غير السرّية في الأوامر التالية، وشغّلها من جذر المستودع:

```bash
PROJECT_ID='your-project-id'
REGION='europe-west1'
DISCORD_GUILD_ID='REPLACE_WITH_GUILD_ID'
BX_OWNER_DISCORD_ID='REPLACE_WITH_OWNER_ID'
RUN_SA="black-x-bot@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts create black-x-bot --project="$PROJECT_ID" # مرة واحدة
for secret in discord-bot-token black-x-api-secret; do
  gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT_ID" \
    --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor
done

gcloud run deploy black-x-bot --source . --project="$PROJECT_ID" --region="$REGION" \
  --service-account="$RUN_SA" --port=8080 --min-instances=1 --max-instances=1 \
  --no-cpu-throttling --no-allow-unauthenticated \
  --set-env-vars="DISCORD_GUILD_ID=$DISCORD_GUILD_ID,BX_OWNER_DISCORD_ID=$BX_OWNER_DISCORD_ID" \
  --set-secrets='DISCORD_BOT_TOKEN=discord-bot-token:latest,BOT_API_SECRET=black-x-api-secret:latest'
```

`--min-instances=1` مع `--no-cpu-throttling` مهمان: اتصال Gateway يحتاج CPU حتى بدون طلبات HTTP. اجعل الحد الأقصى نسخة واحدة لتجنّب ازدواج جلسات Gateway أثناء التشغيل المعتاد، وتجنّب `/setup` أثناء تبديل المراجعات. قد يعيد Cloud Run تشغيل النسخة؛ الحد الأدنى ليس ضمانًا لاتصال بلا انقطاع. اترك فحص بدء Cloud Run الافتراضي **TCP**؛ لا تكشف `/health` بدون سر. امنح هوية خادم الموقع `roles/run.invoker` على الخدمة وأرسل Cloud Run identity token عبر `Authorization: Bearer …` **بالإضافة إلى** `X-BX-Secret`. على أول نشر من المصدر قد يحتاج حساب Cloud Build لصلاحية `roles/run.builder` حسب إعداد المشروع.

### Fly.io (بديل يدوي)

استخدم نفس `Dockerfile` مع `fly launch --no-deploy`، واضبط `DISCORD_GUILD_ID` و`BX_OWNER_DISCORD_ID` في `[env]`، والمتغيرين السريين من Fly Secrets. في `fly.toml` ثبّت الإعدادات التالية:

```toml
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1
```

ثم `fly deploy --ha=false` و`fly scale count 1`. استخدم TCP checks أو أرسل السر إذا كنت تضيف HTTP monitor. تجنّب scale-to-zero حتى لا ينقطع Gateway.

## ٦. حل المشكلات

| العرض | الحل |
|---|---|
| `401` من Discord عند الإقلاع | راجع `DISCORD_BOT_TOKEN` محليًا. لو استخدمت Reset Token حدّث السر وأعد التشغيل. لا تنشر التوكن أو تطبعه. |
| `401` من HTTP | تحقق أن خادم الموقع يرسل `X-BX-Secret` بقيمة `BOT_API_SECRET` الحالية. هذا ليس توكن Discord. |
| `403 Missing Access / Missing Permissions` | تأكد أن البوت موجود في السيرفر الصحيح، ثم افحص `/status` وصلاحيات الروم. لـ `/announce` تحقق تحديدًا من `Embed Links` ومن صلاحية المشرف في الروم. لا تستخدم Administrator كحل. |
| `Used disallowed intents` | الافتراضي `Guilds` فقط. لو ضبطت `BX_WELCOME=1`، فعّل **Server Members Intent** في Developer Portal أو احذف المتغير لتعطيل استقبال أحداث الترحيب. `Message Content` غير مطلوب. |
| `Rate limited` | احترم `Retry-After` للـ HTTP، وتجنّب تشغيل `/setup` مرارًا. عميل Discord ينتظر `retry_after` تلقائيًا. |
| الأوامر لا تظهر | استخدم رابط التثبيت بنطاق `applications.commands`، ثم شغّل `npm run register`، وتأكد من `DISCORD_GUILD_ID` والأذونات الافتراضية للأمر. |
| البوت يظهر Offline | راجع سجل JSON و`/health` بالسر. على Heroku تحقق أن `web` واحد شغّال على Basic أو Standard. على Cloud Run تحقق من `min-instances=1` و`--no-cpu-throttling`، وعلى Fly أوقف الإيقاف التلقائي. |
| رول البوت منخفض | افتح **Server Settings → Roles** وارفع أعلى رول للبوت فوق كل رولات BLACK X، ثم أعد `/setup`. البوت لا يرفع روله بنفسه. |
| الويب هوك القديم لا يعمل | افحص `/status` و**Integrations**. لو الرابط كان اتحذف قبل كده، حدّث تطبيق الإرسال بالرابط العامل بشكل خاص. `/setup` مش بيعطّل روابط موجودة؛ لو فيه نسخ متكررة ثبّت ID النسخة المستخدمة في `DISCORD_WEBHOOK_*`. |

## ٧. الاختبارات والملفات

```bash
npm ci
npm test
```

الاختبارات بـ `node:test` وعميل Discord بالذاكرة. اختبارات HTTP تستخدم `fetch` مع سيرفر محلي مؤقت؛ لا تتصل الاختبارات بـ Discord ولا تحتاج إلى `.env`. يشغّل GitHub Actions الاختبارات على Node.js 20 في كل push وPR.

- `src/index.js` و`src/bot.js` و`src/commands/`: الإقلاع والـ Gateway وأوامر السلاش.
- `src/provisioning.js` و`src/discord/`: مطابقة الموارد، الإعداد، الهرمية، وDiscord REST v10.
- `src/http/` و`src/roles/sync.js`: HTTP ومزامنة الرولات وفحص الصحة.
- `src/community/`: ميزات المجتمع، عامل التذكيرات، وتخزين دائم اختياري لكل سيرفر.
- `src/admin/`: التفويض والسجل وأدوات الإدارة الاختيارية.
- `src/site/` و`integrations/site/`: جسر `/profile` وعقد الـAPI، مع محوّل خادم ومكوّن React للموقع.
- `.env.example` و`Dockerfile` و`.github/workflows/`: الإعداد وصورة النشر على Heroku وCI.
