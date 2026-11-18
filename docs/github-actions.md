# تشغيل BLACK X من GitHub Actions

- **CI** يعمل على `push` و`pull_request`، ويشغّل `npm ci` و`npm test` بدون أي أسرار.
- **Deploy BLACK X to Cloud Run** يعمل يدويًا من `main` بعد مراجعة ودمج الـ PR. يعيد تشغيل CI، ثم ينشر البوت على Cloud Run. الـ runner ينتهي بعد النشر؛ الـ Gateway يبقى متصلًا من Cloud Run. إعداد النسخة الدائمة قد يترتب عليه رسوم Google Cloud.

## ١. الأسرار في Google Cloud، وليس GitHub

في مشروع Google Cloud مخصص للبوت ومفعّل فيه Billing، أنشئ في **Secret Manager**:

| اسم الـ secret | القيمة |
|---|---|
| `discord-bot-token` | قيمة `DISCORD_BOT_TOKEN` من Discord Developer Portal |
| `black-x-api-secret` | قيمة `BOT_API_SECRET` المشتركة مع خادم الموقع |

أنشئ نسخة مفعّلة (`latest`) لكل سر. لا تضف القيم إلى GitHub Variables أو الشات أو أي ملف في المستودع. الـ Action لا يقرأ قيم الأسرار؛ Cloud Run يحقنها وقت التشغيل باستخدام حساب تشغيل منفصل.

## ٢. إعداد هوية النشر بدون مفاتيح JSON

نفّذ الأوامر التالية **مرة واحدة** في Cloud Shell أو جهاز عليه `gcloud` و`gh`. تحتاج حسابًا مخوّلًا بتهيئة IAM، و`gh` يُستخدم هنا لجلب المعرّفات العامة فقط. غيّر `PROJECT_ID` و`REGION` حسب مشروعك، وغيّر `REPO` فقط إذا نقلت المستودع:

```bash
PROJECT_ID='your-project-id'
REGION='europe-west1'
REPO='Hacker5055/discord-x-bot-'
REPO_ID="$(gh api "repos/$REPO" --jq .id)"
REPO_OWNER_ID="$(gh api "repos/$REPO" --jq .owner.id)"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="black-x-bot@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="black-x-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
POOL='black-x-github'
PROVIDER='github'

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

# تخطَّ أمر إنشاء الحساب إذا كان موجودًا مسبقًا.
gcloud iam service-accounts create black-x-bot --project="$PROJECT_ID"
gcloud iam service-accounts create black-x-deployer --project="$PROJECT_ID"
for secret in discord-bot-token black-x-api-secret; do
  gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor
done

# صلاحيات النشر من المصدر، وإبقاء الخدمة غير متاحة للعامة.
for role in roles/run.sourceDeveloper roles/run.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="$role"
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global \
  --display-name='BLACK X GitHub Actions'
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id' \
  --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${REPO_OWNER_ID}' && assertion.ref == 'refs/heads/main' && assertion.environment == 'black-x-production' && assertion.workflow_ref == '${REPO}/.github/workflows/deploy-cloud-run.yml@refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$REPO_ID"
```

امنح `roles/run.builder` لحساب **Cloud Build** الافتراضي داخل هذا المشروع، وليس لـ `black-x-bot` أو `black-x-deployer`. استخدم الأمر الأول لمعرفة الحساب، ثم ضعه في `CLOUD_BUILD_SA`:

```bash
gcloud builds get-default-service-account --project="$PROJECT_ID" --region="$REGION"
CLOUD_BUILD_SA='COPY_SERVICE_ACCOUNT_EMAIL'
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CLOUD_BUILD_SA" --role=roles/run.builder
```

لو سبق أن أنشأت الـ pool أو الـ provider، استخدم الموجود بعد مراجعة شروط الثقة أعلاه. إعداد الهوية قد يحتاج دقائق حتى يظهر أثره. لا تنشئ Service Account Key.

## ٣. إعداد GitHub وتشغيل الـ Action

من **Settings → Environments** أنشئ `black-x-production`، وقصّر **Deployment branches and tags** على `main`. أضف القيم التالية تحت **Environment variables**؛ كلها معرّفات وليست أسرارًا:

| الاسم | القيمة |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID` |
| `GCP_REGION` | `$REGION` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/black-x-github/providers/github` (الرقم، وليس اسم المشروع) |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `$DEPLOY_SA` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `$RUNTIME_SA` |
| `DISCORD_GUILD_ID` | معرّف السيرفر الرسمي |
| `BX_OWNER_DISCORD_ID` | معرّف مالك السيرفر الفعلي |

بعد وصول الـ workflow إلى `main`: افتح **Actions → Deploy BLACK X to Cloud Run → Run workflow** واختر `main`. بعد نجاح النشر، راجع سجل **Cloud Run → black-x-bot → Logs** للتأكد من `gateway_ready`، ثم جرّب `/setup dry_run:true` في Discord. الخدمة ليست عامة؛ خادم الموقع يحتاج `roles/run.invoker` و`X-BX-Secret` حسب [دليل التكامل](../README.md#٤-تكامل-خادم-الموقع).
