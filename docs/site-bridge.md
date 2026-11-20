# BLACK X: الترحيب، أسئلة الدخول، ولوحة Discord في الموقع

التكامل متوقف افتراضيًا. البوت يملك سجل التذاكر على الطرفين، والموقع يملك جلساته وربط Discord OAuth. ملفات هذا المستودع **لا تنشر واجهة الموقع تلقائيًا**: ركّب محوّل الخادم ومكوّن `/profile` على مصدر الموقع أو سلّم العقد لفريق الموقع، ثم اختبر في سيرفر تجريبي. لا تحتاج إعادة `/setup`، ولا تعديل `/daily` أو مزامنة الكتالوج الحية للتجربة.

## الترحيب وأسئلة الدخول

1. المالك الفعلي المطابق لـ`BX_OWNER_DISCORD_ID` ينشئ روم ترحيب يقدر الأعضاء الجدد يشوفوه بعد قبول القوانين. أعطِ البوت `View Channel` و`Send Messages` و`Embed Links` في الروم فقط.
2. `/welcome configure channel:#welcome owner_name:اسمك message:رسالتك`. مثال للرسالة: «نورت BLACK X! أنا [اسمك]، صاحب السيرفر. ابدأ بقراءة القوانين وعرّفنا على الأنمي اللي بتحبه. ولو عندك مشكلة في الموقع، افتح تذكرة من حسابك أو من روم الدعم.»
3. `/welcome social platform:instagram url:رابط_حسابك`، وهكذا لـYouTube وTikTok وX وFacebook وTwitch وGitHub. استخدم روابط بروفايل HTTPS مباشرة، من غير رابط مختصر أو معاملات تتبّع. `/welcome social platform:instagram` بدون `url` يمسح الزر. البوت لا يفتح الروابط ولا يفترض حسابات المالك؛ راجعها بـ`/welcome preview` (معاينة خاصة لا تنشر شيئًا).
4. لتشغيل الترحيب الحقيقي فقط، فعّل **Developer Portal → Bot → Server Members Intent**، ثم اضبط `BX_WELCOME=1` في بيئة البوت. بعد تشغيل النسخة بالإعداد الجديد: `/welcome enable enabled:true`. ده مستقل عن `/admin enable`. `/welcome enable enabled:false` يوقفه بدون إعادة تشغيل.
5. رسالة موحدة بتوقيع المالك لكن باسم العضو الجديد، في روم الترحيب فقط، بعد قبول Rules Screening لو العضو بدأ بحالة Pending. لا DM، لا منشن تنبيه، لا محتوى محادثات، لا منح رولات من الترحيب. لو البوت غاب وقت الانضمام أو قبول القوانين مش هيبعت بأثر رجعي. يمنع تكرار حدث الانضمام بنفس التوقيت ضمن آخر 512 إيصالًا ولمدة 7 أيام؛ الإرسال محاولة واحدة علشان ما يكررش الرسالة عند نتيجة غير مؤكدة.

### أسئلة Discord Onboarding (مش نموذج خارجي)

1. في Discord على سطح المكتب: **Server Settings → Enable Community** لو غير مفعّلة، ثم **Onboarding**. اختار Default Channels عادية للداخلين؛ في الإعداد الافتراضي Discord بيطلب ٧ رومات افتراضية و٥ على الأقل تسمح لـ`@everyone` بالكتابة. لا تفتح رومات دعم أو إدارة خاصة لتحقيق الشرط. راجع [دليل Discord Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ) لمتطلبات وضع السيرفر.
2. خريطة مقترحة للمراجعة: سؤال **«تحب يظهر أي رول بجانب اسمك؟»**، اختيار واحد، مطلوب، و**Ask before a member joins**. `Boy → Members + Boy`، `Girl → Members + Girl`، `أفضل التخطي → Members فقط`. السؤال مطلوب للمرور لكن اختيار النوع نفسه مش مطلوب؛ لا تطلب اسمًا حقيقيًا أو عمرًا أو أي بيانات شخصية. لو محتاج سؤال تاني، مثال: «تحب تتابع إيه؟» باختيارات رومات عامة، من غير رولات مميزة.
3. اختار الرولات من السيرفر بالمعرّف الفعلي (اختيار Discord، مش اسم متخمن). شغّل `/welcome onboarding members:@Members boy:@Boy girl:@Girl` قبل/بعد ضبط السؤال. يفحص الرولات الحقيقية والإعداد المحفوظ في Discord؛ لا يغيّر السؤال أو الدعوات ولا يمنح رولًا. يقبل الرولات الثلاثة فقط كاختيارات مقترحة، ويشترط بلا صلاحيات أو overwrites أو تفويض. لو `Members` عندك بيفتح رومات خاصة، راجع تصميم الوصول بدل ما تشيل الصلاحيات عشوائيًا.
4. راجع **Preview** في Discord واحفظ من هناك، ثم جرّب بحساب جديد في سيرفر الاختبار. `BLACK X` وVIP وCreator ورولات الفرق **مش اختيارات**. إجابات Onboarding مش إثبات هوية أو وسيلة لتفويض فريق؛ ممكن العضو يغيّر اختياره بعد الدخول. استخدم **Rules Screening** لقبول القواعد. ده أثناء مسار الدخول في Discord وليس نظام موافقة خارجية يقفل كل الدعوات.

## تفعيل جسر التذاكر في بيئة اختبار

- شغّل البوت على تخزينه الدائم الحالي (Turso أو Postgres) و**web dyno واحد**. اضبط قيمة مستقلة عالية العشوائية لـ`BX_SITE_BRIDGE_SECRET` على البوت وخادم الموقع (32 بايت عشوائية مرمّزة base64url تكفي). لا تعِد استخدام `BOT_API_SECRET` أو أسرار Discord/Turso، ولا تضف القيمة في سورس أو متغير واجهة مثل `VITE_…`. استخدم HTTPS بين الخادمين.
- جهّز روم فتح تذاكر، كاتيجوري دعم منفصلة وفاضية، ورول `Support` مخصص. `/admin room purpose:ticket_panel channel:#support` ثم `purpose:ticket_category` للكاتيجوري. `/admin team team:support role:@Support channel:#support-staff` ثم `/admin room purpose:site_staff channel:#support-staff`. العضو يحتاج رؤية روم الفتح؛ الموظف يحتاج الرول، روم `site_staff` ضمن نطاق الفريق، ورؤية الروم. المالك المطابق لا يحتاج رول تفويض.
- الكاتيجوري تحتاج صلاحيات البوت المذكورة في [دليل الإدارة](administration.md). كل تذكرة تنشئ رومًا منفصلًا بأذونات دقيقة: منع `@everyone`، وسماح لصاحبها، البوت وفريق الدعم. مالك السيرفر أو من معه Administrator يقدر يتجاوز overwrites بطبيعة Discord؛ لا تعطِ Administrator إلا لمن تثق به. لا تعدّل اسم الموضوع `bx-ticket:…` أو أذونات الروم يدويًا.
- `/admin enable enabled:true` ثم `/admin bridge enabled:true` من المالك. أعِد `/ticket panel` في روم الدعم لو عايز زر «تذاكري على الموقع» بعد نشر الواجهة. لإيقاف الموقع ومشاركة الرسائل الجديدة فورًا: `/admin bridge enabled:false` (لا يلغي تذاكر Discord ولا يمسح البيانات). النقل لمالك جديد يحتاج تحديث `BX_OWNER_DISCORD_ID`، تدوير سر الجسر، وتفعيل جديد من المالك.

لو المالك جهّز [روم الشكاوى بـ`/server prepare`](server-prepare.md)، البلاغ الجديد (`type:report`) من الموقع بيطلع تنبيهًا خاصًا برابط التذكرة. محتوى الموقع والردود اللاحقة ما بيتنسخوش في الخاص؛ نص نموذج Discord المقصود يصل للمالك فقط كما يوضّح النموذج قبل الإرسال.

### دورة التذكرة

- فتح من `/ticket open` أو زر اللوحة **أو** من حساب الموقع المرتبط. الحد تذكرة واحدة نشطة لكل عضو، و٣٥ نشطة للسيرفر. الرقم نفسه صالح على الطرفين، وليس لازم يساوي معرّف روم Discord. يقدر المالك/الدعم يستلموا ويردوا ويقفلوا من أي طرف. الإغلاق يمنع كتابة صاحب التذكرة العادي من غير حذف الروم.
- الرسالة المكتوبة **داخل واجهة التذاكر في الموقع** تتشارك مع روم التذكرة. من Discord: صاحب التذكرة يستخدم `/ticket share id:… body:…` داخل رومه؛ الدعم يستخدم `/ticket reply id:… body:… share:true` من روم تفويضه. `/ticket reply` العادي ورسائل الشات العادية **لا تتنسخ للموقع**. لا تمنح `Message Content Intent`. اعرض تنبيه إن الرد من المسار المشترك ظاهر لطرفي التذكرة. لا ترسل أسرارًا أو بيانات حساسة.
- حالة `unconfirmed` معناها أن النص المشترك اتسجل لكن توصيل Discord مش مؤكد. لا تعيد الإرسال تلقائيًا أو بمفتاح جديد في الحالة دي؛ راجع الروم يدويًا. تكرار نفس المفتاح لا يكرر الرسالة. لو إنشاء الروم رجع بشكل غير مؤكد جرّب **نفس** مفتاح الفتح؛ البوت يبحث عن الروم المطابق بدل عمل نسخة ثانية. لو الرابط أو الأذونات مش سليمة، لا تعرض الرسائل، وخلي الدعم يراجع Discord.
- احتفظ بالرقم ووقت الإجراء لا بنسخة خارجية من النص. حد النص ١٠٠٠ وحدة UTF‑16، وبحد أقصى ٤٠ رسالة مشتركة لكل تذكرة و٣٨٤ KiB لسجلات الرسائل المشتركة في السيرفر. عند الامتلاء كمّل من Discord بدون مشاركة. نفس سياسة سجل الطلبات الحالي: حتى ٣٠٠ سجل؛ تُنظّف سجلات الطلبات المقفولة الأقدم من ٩٠ يومًا عند إضافة طلب، أو قد تُزال أقدم من ٧ أيام عند ضغط السعة. الرومات ورسائل Discord لا تُحذف آليًا. لازم تذكر حفظ الرسائل المشتركة ضمن سياسة دعم الموقع.

## عقد الموقع → البوت (v1)

كل العمليات `POST /api/site/v1/<action>` مع `Content-Type: application/json` و`X-BX-Bridge-Secret` من **خادم الموقع**. أضف `discordId` كسلسلة من الربط OAuth **الفعّال والمتحقق منه** لجلسة الموقع الحالية. لا تقبله أو تقبل `guildId` أو `staff` أو `roleId` أو وجهة من المتصفح. اقفل استعلامات الفريق بشرط فريق الموقع الموثوق **أيضًا**؛ البوت يراجع حالة العضو والرول ونطاق الروم من Discord لكل طلب. لا تمنح مزايا الموقع المدفوعة من مجرد نتائج `profile`: الموقع يبقى المرجع للاشتراكات.

| `<action>` | المفاتيح المطلوبة بجانب `discordId` | النجاح (بجانب `ok:true`) |
| --- | --- | --- |
| `profile` | — | `discordId`, `guildId`, `membership:member\|pending\|not_member`, `roles` (`vip_monarch`, `vip_basic`, `creator` فقط)، `capabilities:{canUseTickets,canOpenTicket,canViewDashboard}` |
| `dashboard` | — | الحالة المباشرة أدناه (المالك أو الدعم المصرّح) |
| `tickets/list` | — | `{tickets}` لتذاكر العضو نفسه |
| `tickets/open` | `type:site\|report`, `requestId` | `{ticket}`، وبعده استخدم `/tickets/reply` لإرسال التفاصيل |
| `tickets/detail` | `id` | `{ticket,reason,messages}` |
| `tickets/reply` | `id`, `body`, `requestId` | `{ticket,message}` |
| `staff/tickets/list` | — | `{tickets}` في نطاق الدعم الحالي |
| `staff/tickets/detail` | `id` | `{ticket,reason,messages}` |
| `staff/tickets/claim` | `id` | `{ticket}` |
| `staff/tickets/reply` | `id`, `body`, `requestId` | `{ticket,message}` |
| `staff/tickets/close` | `id`, `reason` (حتى ٢٥٠، ظاهر للعضو) | `{ticket}` |
| `staff/tickets/intake` | `paused` (boolean، المالك فقط) | `{paused}`؛ نفس حالة `/admin pause module:tickets` على الموقع وDiscord |

- `id` و`discordId` سلاسل، لا تحوّلها لأرقام JS. `requestId` هو UUID v4 لكل فعل فتح/إرسال جديد. احتفظ **بنفس** المفتاح ونفس النص/النوع عند إعادة المحاولة بعد خطأ شبكة أو timeout، علشان ما تنشئش نسخة تانية. تغيير بيانات مفتاح مستخدم يرجع `SITE_REQUEST_CONFLICT`. لو `ADMIN_DUPLICATE_REQUEST` اعرض التذكرة الحالية من `tickets/list`. لو `SITE_REQUEST_EXPIRED` ما تستخدمش مفتاح فتح قديم انتهت مدة سجله.
- `ticket`: `{id,type,origin,status,createdAt,openedAt,claimedAt,closedAt,firstReplyAt,roomState,discordUrl,writable}`. `origin`: `site|discord`. `status`: `opening|open|claimed|closed`. `roomState`: `available|opening|blocked|missing`. `discordUrl` رابط Discord أو `null`. مسارات الدعم فقط تضيف `requesterDiscordId,assigneeDiscordId` وقد يكونان `null`. كل الأوقات أعداد Unix ms أو `null`. التفاصيل تعيد `reason:null,messages:[]` لو الروم غير متاح. الرؤية في الموقع مش بديل لتصاريح Discord.
- `message`: `{id,body,side,origin,at,delivery}`. `side`: `requester|support`. `delivery`: `sent|unconfirmed`. اعرض `body` والسبب كنص (لا HTML ولا Markdown غير مؤمّن). كل النجاح `200` بما فيه نتيجة `unconfirmed`؛ فحص `ok:true` لوحده لا يؤكد التسليم.
- `dashboard`: `{observedAt,health:{ready,gatewayReady,uptimeSeconds,memberCount},adminEnabled,welcomeEnabled,tickets:{configured,paused,canSetIntake,counts:{opening,open,claimed,closed}},catalog:{count,idsSha256,lastAccepted,lastRejectedSinceBoot}}`. وقت آخر دفعة مقبولة `{at,batch,removed}` دائم؛ `lastRejectedSinceBoot:{at,status,code}` ذاكرة الإقلاع الحالي؛ الحالتان `null` قبل وجود دليل. `idsSha256` هو SHA‑256 hex لمعرفات **المجموعة المرسلة للبوت فقط**، مرتبة بـ`.sort()` ومفصولة بـLF بدون LF أخير، UTF‑8. طابقها محليًا مع نفس مجموعة IDs المقصودة في الموقع، ولا تعتبرها إثباتًا لتطابق حقول العناصر أو مزامنة كل الكتالوج. العرض لا يشغّل sync أو episode jobs ولا يغيّر حد ٥٠٠ عمل.
- الخطأ `{ok:false,code,message}`، بدون كاش أو CORS. `401 UNAUTHORIZED` اعتماد الخادم؛ `404 NOT_FOUND` الجسر غير مكوّن/المسار خطأ، و`404 ADMIN_NOT_FOUND` تذكرة مش متاحة (نفسه إذا كانت من حساب آخر). `403` لعدم العضوية/قواعد الدخول/الدور والصلاحيات. `409` لتغيير الحالة/الخصوصية/الإيقاف/التكرار. `429` حدود، احترم `Retry-After` عند وجوده؛ افتراضيًا ٢٠ طلب/دقيقة للحساب و١٢٠ لمصدر الاتصال، منفصلة عن واجهة الكتالوج والرولات القديمة. `502` Discord فشل أو غير متاح؛ `503` جسر معطّل أو تخزين غير متاح. استخدم تحديثًا عند فتح اللوحة وبعد الكتابة/الطلب اليدوي، مش polling سريعًا. من غير ما تسجّل نص التذكرة أو الأسرار أو هوية مستخدم من الراوتر.

## تركيب `/profile` على مصدر الموقع

1. استخدم [محوّل خادم الموقع](../src/site/proxy.js) (`createProfileProxy`، Web `Request`/`Response`) أو طبّق نفس العقد في راوتر الموقع الحالي. إذا نقلت المحوّل بين المستودعات، انقل معه `src/site/contract.js` وملفّي `src/lib/catalog.js` و`src/lib/errors.js` مع المسارات المناسبة. سجّل POST `/api/profile/discord/v1/<action>` على **خادم** الموقع؛ مرّر `siteOrigin` و`botOrigin` (أصل HTTPS ثابت من الإعداد)، و`secret` (من Secret Manager). المحوّل يقارن `Origin` الثابت، يمنع الطلبات خارج الأصل، يفحص JSON بحجم محدود ولا يتبع Redirects ولا يمرّر هيدرز الجلسة أو التوكن للبوت.
2. اربط `getSession(request)` بجلسة الموقع الموثوقة الحالية (لا تنشئ جلسة جديدة للوحة)، `getVerifiedDiscordId(session)` باستعلام سيرفري يعيد الـID الفعّال والفريد المتحقق منه بـDiscord OAuth؛ يرجع `null` لو مش مربوط/اتلغى الربط. `isStaff(session)` يفحص تفويض الدعم/الإدارة في الموقع، `true` صريح فقط. طبّق أي CSRF middleware موجود قبل المحوّل. لا تستنتج الربط من اسم الحساب أو حقل قابل للتعديل. لو هتستخدم Express، اعمل المحوّل قبل استهلاك body أو استخدم راوتر الموقع الحالي لبناء request من JSON محدود ومتحقق منه؛ لا تعتمد على رؤوس `Host`/`X-Forwarded-*` من العميل.
3. [مكوّن React](../integrations/site/DiscordProfile.jsx) مع [الستايل](../integrations/site/discord-profile.css) مركّب على REST الحقيقي: حالة الحساب والرولات، عرض/فتح/رد على التذاكر، وصندوق الفريق والاستلام والرد والإغلاق، والتحكم في استقبال التذاكر للمالك. استدعِ `DiscordProfileBridge` داخل `/profile` بعد التحقق من تسجيل الدخول. مرّر `linkControls` (زر OAuth الحالي للموقع)، `siteStaff` من حالة المستخدم الحالية للعرض فقط، و`fetchImpl` لو الموقع يستخدم auth fetch خاص بدل cookies. اربط `key` بمعرّف حساب الموقع ونسخة الربط، وافصل المكوّن عند تسجيل الخروج؛ لا تخزّن استجابات أو رسائل التذاكر في Local Storage أو CDN. واجهات الرولات والكتالوج والحلقات القديمة ومفاتيحها بدون تغيير.
4. قبل النشر: في بيئة الاختبار افتح من الموقع ورد من Discord، افتح من Discord ورد من الموقع، اقفل من الطرف الآخر، وأوقف الاستقبال من اللوحة وتأكد إنه توقف على الطرفين بدون المساس بالتذاكر المفتوحة. جرّب حسابًا تاني، ربطًا اتلغى، عضوًا Pending، فقد رول الدعم وتذكرة اتغيّرت أذوناتها. بعد ذلك جرّب الدخول الجديد والترحيب والأسئلة. اطمن إن `/daily` وVIP والترشيحات القديمة شغالة من غير بدء sync أو إرسال DMs كتجربة.

الاختبار المحلي: `npm test`. يتضمن HTTP حقيقيًا بين محوّل الموقع وسيرفر البوت، وDiscord وتخزين اختبار، وليس تصريحًا إن النشر تم على Heroku أو `black-x-anime.ai.studio`.
