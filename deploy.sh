#!/bin/bash
# 営業サポート — Cloud Run デプロイスクリプト(他プロジェクトと同じ sansuiso-apps / asia-northeast1)
# 実行: bash deploy.sh
set -e
cd "$(dirname "$0")"

PROJECT=sansuiso-apps
REGION=asia-northeast1
SERVICE=eigyo-support
BUCKET=sansuiso-eigyo-data
SECRET=EIGYO_SITE_PASSWORD

echo "① データ用バケットを用意..."
gcloud storage buckets create gs://$BUCKET --location=$REGION --project=$PROJECT --uniform-bucket-level-access 2>/dev/null \
  || echo "   (作成済みのためスキップ)"

echo "② 合言葉(ログイン用)のシークレットを用意..."
if ! gcloud secrets describe $SECRET --project=$PROJECT >/dev/null 2>&1; then
  PW=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 12)
  printf '%s' "$PW" | gcloud secrets create $SECRET --project=$PROJECT --replication-policy=automatic --data-file=-
  echo "   新しい合言葉を作成しました: $PW"
  echo "   (あとで確認: gcloud secrets versions access latest --secret=$SECRET --project=$PROJECT)"
else
  echo "   (作成済み。変更するには: printf '新しい合言葉' | gcloud secrets versions add $SECRET --project=$PROJECT --data-file=- のあと再デプロイ)"
fi

# Cloud Run のサービスアカウントにバケットとシークレットの権限を付ける
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --project=$PROJECT >/dev/null
gcloud secrets add-iam-policy-binding $SECRET --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null  # 写真読み取り・AI注文用(社内共用キー)

echo "③ Cloud Run へデプロイ(3〜5分かかります)..."
gcloud run deploy $SERVICE \
  --source . \
  --project=$PROJECT \
  --region=$REGION \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=1 \
  --memory=512Mi \
  --timeout=300 \
  --set-env-vars=DATA_DIR=/data,TRUST_PROXY=1 \
  --set-secrets=SITE_PASSWORD=$SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --add-volume=name=data,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=data,mount-path=/data

echo ""
echo "✅ デプロイ完了! 公開URL:"
gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format='value(status.url)'
