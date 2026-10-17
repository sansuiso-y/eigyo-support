#!/bin/bash
# 営業サポート — Cloud Run デプロイスクリプト(他プロジェクトと同じ sansuiso-apps / asia-northeast1)
# 実行: bash deploy.sh
set -e
cd "$(dirname "$0")"

PROJECT=sansuiso-apps
REGION=asia-northeast1
SERVICE=eigyo-support
BUCKET=sansuiso-eigyo-data
SETUP_SECRET=EIGYO_SITE_PASSWORD   # 初期設定コード(最初の管理者を作るときに1回だけ使う)
SESSION_SECRET_NAME=EIGYO_SESSION_SECRET

echo "① データ用バケットを用意..."
gcloud storage buckets create gs://$BUCKET --location=$REGION --project=$PROJECT --uniform-bucket-level-access 2>/dev/null \
  || echo "   (作成済みのためスキップ)"

echo "② 初期設定コードとセッション鍵のシークレットを用意..."
if ! gcloud secrets describe $SETUP_SECRET --project=$PROJECT >/dev/null 2>&1; then
  CODE=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 12)
  printf '%s' "$CODE" | gcloud secrets create $SETUP_SECRET --project=$PROJECT --replication-policy=automatic --data-file=-
  echo "   初期設定コードを作成しました(確認: gcloud secrets versions access latest --secret=$SETUP_SECRET --project=$PROJECT)"
else
  echo "   (初期設定コードは作成済み。確認: gcloud secrets versions access latest --secret=$SETUP_SECRET --project=$PROJECT)"
fi
if ! gcloud secrets describe $SESSION_SECRET_NAME --project=$PROJECT >/dev/null 2>&1; then
  LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64 | gcloud secrets create $SESSION_SECRET_NAME --project=$PROJECT --replication-policy=automatic --data-file=-
  echo "   セッション鍵を作成しました"
fi

# Cloud Run のサービスアカウントにバケットとシークレットの権限を付ける
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --project=$PROJECT >/dev/null
gcloud secrets add-iam-policy-binding $SETUP_SECRET --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null
gcloud secrets add-iam-policy-binding $SESSION_SECRET_NAME --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null  # 写真読み取り・AI注文用(社内共用キー)

echo "③ Cloud Run へデプロイ(3〜5分かかります)..."
gcloud run deploy $SERVICE \
  --source . \
  --project=$PROJECT \
  --region=$REGION \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=1 \
  --memory=1Gi \
  --timeout=300 \
  --set-env-vars=DATA_DIR=/data,TRUST_PROXY=1,AUTH_REQUIRED=1 \
  --set-secrets=SETUP_CODE=$SETUP_SECRET:latest,SESSION_SECRET=$SESSION_SECRET_NAME:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --add-volume=name=data,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=data,mount-path=/data

echo ""
echo "✅ デプロイ完了! 公開URL:"
echo "   はじめて開くときは「初期設定コード」で最初の管理者を作成します。コードの確認: gcloud secrets versions access latest --secret=$SETUP_SECRET --project=$PROJECT"
gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format='value(status.url)'
