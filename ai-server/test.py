"""
Kiểm tra model chạy đúng trên máy bạn, TRƯỚC khi deploy.
Chạy:  pip install pandas   (chỉ để chạy file test này)
       python test_local.py ../cpm_historical_data.csv
Kết quả mong đợi: accuracy gần 1.0 và 'SHAP cộng lại == margin: True'.
"""
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

from main import FEATURES, GoalIn, LABELS, booster, to_row

df = pd.read_csv(sys.argv[1]).head(1000)
rows = [
    to_row(GoalIn(
        name=str(r.goal_name),
        expected_progress=float(r.expected_progress),
        actual_progress=float(r.actual_progress),
        overdue_tasks=int(r.overdue_tasks),
        days_remaining=float(r.days_remaining),
        total_duration_days=float(r.total_duration_days),
    ))
    for r in df.itertuples()
]
X = np.array(rows, dtype=np.float32)
proba = booster.predict(xgb.DMatrix(X, feature_names=FEATURES))
pred = np.array(LABELS)[proba.argmax(axis=1)]
print("cột đặc trưng:", FEATURES)
print("accuracy trên", len(df), "dòng:", round(float(np.mean(pred == df.risk_level.to_numpy())), 4))

dm1 = xgb.DMatrix(X[:1], feature_names=FEATURES)
margin = np.asarray(booster.predict(dm1, output_margin=True)).reshape(1, len(LABELS))
contrib = np.asarray(booster.predict(dm1, pred_contribs=True)).reshape(1, len(LABELS), -1)
print("SHAP cộng lại == margin:", bool(np.allclose(contrib.sum(axis=2), margin, atol=1e-3)))

ccontrib = np.asarray(booster.predict(xgb.DMatrix(X, feature_names=FEATURES), pred_contribs=True)).reshape(len(X), len(LABELS), -1)
high = ccontrib[:, LABELS.index("High Risk"), :-1]   # SHAP của High Risk: dương = làm tăng rủi ro, âm = làm giảm
print("Ảnh hưởng trung bình lên High Risk:")
print(pd.Series(np.abs(high).mean(axis=0), index=FEATURES).sort_values(ascending=False).round(3))
print("Dòng 0 (model đoán:", pred[0], ") các yếu tố chính:")
print(pd.Series(high[0], index=FEATURES).sort_values(key=abs, ascending=False).head(3).round(2))