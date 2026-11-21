# نشر BLACK X على Heroku من GitHub Actions

**CI** يعمل على `push` و`pull_request` بدون أسرار. بعد الدمج في `main`، شغّل **Deploy BLACK X to Heroku** يدويًا: يعيد الاختبارات، ويبني صورة `web` من الـ `Dockerfile` على `linux/amd64`، ثم يدفعها إلى Heroku Container Registry ويطلب إصدارها. **البوت يعمل على Heroku، وليس على runner الخاص بـ GitHub.**

## ١. تطبيق Heroku وإعداداته

استخدم تطبيقًا من نوع **Cedar** مع stack اسمه `container`. اختر اسم تطبيق فريدًا؛ ده الاسم في الداشبورد، وليس رابط التطبيق. لو هتنشئ تطبيقًا جديدًا من Heroku CLI بعد تسجيل الدخول:

```bash
APP_NAME='replace-with-your-app-name'
heroku apps:create "$APP_NAME" --stack container --no-remote
```

لو عندك تطبيق **Cedar** مخصص للبوت بالفعل ولم يُضبط على Docker، لا تنشئه مرة أخرى؛ اضبط الـ stack مرة واحدة:

```bash
APP_NAME='replace-with-your-app-name'
heroku stack:set container --app "$APP_NAME"
```

من **Heroku Dashboard → تطبيقك → Settings → Config Vars** أضف القيم:

| المتغير | القيمة |
|---|---|
| `DISCORD_BOT_TOKEN` | توكن Bot من Discord Developer Portal. |
| `DISCORD_GUILD_ID` | معرّف السيرفر الرسمي. |
| `BX_OWNER_DISCORD_ID` | معرّف مالك السيرفر الفعلي. |
| `BOT_API_SECRET` | سر منفصل مشترك مع خادم الموقع. |

لا تضبط `PORT`: Heroku يعيّنه تلقائيًا، والبوت يستمع عليه. صورة Docker تستخدم Node.js 20 ولا تحتاج إلى Node.js buildpack. لا ترفع `.env` أو توكن Discord أو سر الموقع إلى GitHub. معرّفات `DISCORD_*` الاختيارية من `/setup scope:integrations` يمكن إضافتها لاحقًا في نفس **Config Vars**.

## ٢. إعداد اعتماد النشر في GitHub

من **Settings → Environments** في GitHub، أنشئ أو افتح `black-x-production`، وقصّر **Deployment branches and tags** على `main`:

- **Environment variable:** `HEROKU_APP_NAME` = اسم تطبيق Heroku (ليس URL).
- **Environment secret:** `HEROKU_API_KEY` = اعتماد Heroku صالح لحساب عنده صلاحية نشر على هذا التطبيق. الأفضل حساب نشر وصوله مقتصر على هذا التطبيق. ضعه في **Secrets** وليس **Variables** أو الشات.

المفتاح هنا يخص **Heroku** فقط، وليس توكن Discord أو GitHub. لا تحتاج إلى مشروع Google Cloud أو إلى إعدادات OIDC لتشغيل هذا الـworkflow.

## ٣. تشغيل النشر والتحقق

1. بعد دمج الـPR في `main`، افتح **Actions → Deploy BLACK X to Heroku → Run workflow** واختر `main`. ممكن تكتب اسم التطبيق المقصود في `expected_app`؛ لو مش مطابق لإعداد بيئة النشر، الأمر بيقف قبل الرفع. الصورة بتترفع كـmanifest واحد لـ`linux/amd64`. قبل الإصدار، الـworkflow يطابق `config.digest` من Heroku Registry مع بصمة الـconfig الفعلي جوّه أرشيف الصورة بعد البناء. `.Id` وبعض بيانات Buildx ممكن تشير للـmanifest أو الـindex بدل الـconfig؛ الاختبار في PR يبني الصورة ويحسب البصمة على نفس نوع runner، من غير رفع أو أسرار. لو التحقق فشل، مش هيطلب إصدار.
2. بعد أول إصدار، من **Heroku Dashboard → Resources** اضبط **dyno واحد `web` على Basic أو Standard**. لا تحتاج `worker` لأن نفس العملية تشغّل Gateway وواجهة HTTP. `Eco` قد ينام عند عدم وجود نشاط HTTP، فلا تعتمد عليه لإبقاء البوت متصلًا. الخطط الدائمة مدفوعة؛ الـAction لا يغيّر خطة الحساب أو عدد الـdynos.
3. تابع السجل وتحقق من `gateway_ready`، ثم جرّب `/status` داخل Discord. لتجهيز الدعم، استخدم معاينة `/setup`؛ وللاختيار اليدوي أو أذونات باقي الرومات، استخدم `/server prepare`. نجاح الـAction يعني أن Heroku قبل طلب الإصدار، وليس أن الـGateway أصبح جاهزًا بعد.

```bash
heroku ps --app "$APP_NAME"
heroku logs --tail --app "$APP_NAME"
```

رابط الموقع هو عنوان HTTPS المعروض في Heroku عند **Open app**. استخدمه كـ `BX_URL` في [دليل التكامل](../README.md#٤-تكامل-خادم-الموقع). المسارات، بما فيها `/health`، تتطلب `X-BX-Secret`؛ فتحها في المتصفح بدون الترويسة يرجع `401` وهذا متوقع. استخدم السر من خادم الموقع فقط، وليس من JavaScript المتصفح.

| لو حصل | راجع |
|---|---|
| فشل التحقق من تطبيق Heroku قبل الرفع | `HEROKU_APP_NAME`، وسر `HEROKU_API_KEY`، وصلاحية الحساب على التطبيق، و`container` stack على Cedar. |
| Heroku رفض إصدار الصورة بعد الرفع | راجع كود HTTP ونوع المورد (لو معروف) في رسالة **Push and release to Heroku** وActivity للتطبيق. لو الاتصال انقطع ونتيجة الإصدار مش مؤكدة، افحص Activity قبل إعادة المحاولة. مفيش قيمة سر لازم تتبعت في الشات. |
| لا يظهر زر **Run workflow** | تأكد أن `.github/workflows/deploy-heroku.yml` وصل إلى `main`. |
| الإصدار اتقبل والبوت Offline أو ظهر `H10` / `R10` | افحص `heroku logs`، قم بتشغيل `web` واحد، راجع Config Vars، واترك `PORT` لـ Heroku. |

لتفعيل حفلات المشاهدة والتنبيهات والكتالوج وترتيب الأسبوع، راجع [إعداد ميزات المجتمع](community.md#التفعيل-على-heroku) على تطبيق **البوت**. متغيرات Turso (`TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`) أو PostgreSQL (`DATABASE_URL` و`BX_DATABASE_CA`) في **Heroku Config Vars**، مش في GitHub Actions أو Google AI Studio.
