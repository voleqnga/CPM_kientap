"""
Server AI cho CPM Dashboard.
Nhận danh sách goal của một nhân viên, trả về: nhãn rủi ro, các yếu tố SHAP, nhận xét và đề xuất.

Chạy thử:   uvicorn main:app --reload --port 8000
Xem docs:   http://localhost:8000/docs
"""
import math
from pathlib import Path

import numpy as np
import xgboost as xgb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

MODEL_PATH = Path(__file__).with_name("cpm_xgb_model.json")

# Thứ tự lớp của model (đã kiểm chứng với cpm_historical_data.csv)
LABELS = ["Normal", "Low Risk", "High Risk"]
HIGH = 2  # chỉ số của lớp High Risk

# Web nào được phép gọi server này. Sau khi deploy frontend, thêm địa chỉ Netlify vào đây.
ALLOWED_ORIGINS = [
    "http://localhost:4200",
    # "https://ten-site-cua-ban.netlify.app",
]

# Dùng khi file model không lưu tên cột (bình thường tên cột được đọc thẳng từ file model)
DEFAULT_FEATURES = [
    "expected_progress", "actual_progress", "overdue_tasks",
    "days_remaining", "total_duration_days", "gap", "time_left_ratio",
]

LABEL_VI = {
    "expected_progress": "Tiến độ kỳ vọng",
    "actual_progress": "Tiến độ thực tế",
    "overdue_tasks": "Việc quá hạn",
    "days_remaining": "Số ngày còn lại",
    "total_duration_days": "Thời lượng mục tiêu",
    "gap": "Mức chậm so với tiến độ kỳ vọng",
    "time_left_ratio": "Tỷ lệ thời gian còn lại",
}

booster = xgb.Booster()
booster.load_model(str(MODEL_PATH))
FEATURES = list(booster.feature_names or DEFAULT_FEATURES)

app = FastAPI(title="CPM AI server")

# Cấu hình CORS để Netlify có thể gọi API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://donasacpm.netlify.app",
        "http://localhost:4200",
        "http://localhost:4200/",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],  # Khai báo tường minh phương thức OPTIONS ở đây luôn
    allow_headers=["*"],
)

class OverdueIn(BaseModel):
    name: str = ""
    due_date: str = ""
    days_late: int = 0

class GoalIn(BaseModel):
    name: str = ""
    expected_progress: float      # tiến độ kỳ vọng (%)
    actual_progress: float        # tiến độ thực tế (%)
    overdue_tasks: int            # số việc quá hạn
    days_remaining: float         # số ngày còn lại
    total_duration_days: float    # tổng số ngày của mục tiêu
    overdue_items: list[OverdueIn] = []

class PredictIn(BaseModel):
    goals: list[GoalIn]
    audience: str = "employee"

def to_row(g: GoalIn) -> list[float]:
    """Đổi một goal thành 1 dòng đặc trưng, đúng thứ tự cột của model."""
    total = max(g.total_duration_days, 1)
    days = min(max(g.days_remaining, 0), 30)  # dữ liệu huấn luyện chỉ có 0-30 ngày
    values = {
        "expected_progress": g.expected_progress,
        "actual_progress": g.actual_progress,
        "overdue_tasks": g.overdue_tasks,
        "days_remaining": days,
        "total_duration_days": total,
        "gap": g.expected_progress - g.actual_progress,   # khớp lúc huấn luyện: kỳ vọng - thực tế
        "time_left_ratio": days / total,
    }
    return [values[f] for f in FEATURES]

def r1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10   # làm tròn giống màn hình


def pct(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".")

def build_text(goals: list[GoalIn], w: GoalIn, label: str, manager: bool) -> tuple[str, list[dict]]:
    """Nhận xét và đề xuất viết theo luật từ kết quả model."""

    n = len(goals)
    done = r1(sum(g.actual_progress for g in goals) / n)
    should = r1(sum(g.expected_progress for g in goals) / n)
    behind = r1(should - done)
    overdue = sum(g.overdue_tasks for g in goals)
    days = int(min(max(g.days_remaining, 0) for g in goals))
    when = f"còn {days} ngày nữa là đến hạn" if days > 0 else "đã đến hạn"
    items = sorted(((g.name, it) for g in goals for it in g.overdue_items),
                   key=lambda x: x[1].days_late, reverse=True)

    if label == "Normal":
        return (f"Tiến độ chung đang ổn: đã xong {pct(done)}% công việc, mức cần đạt vào lúc này là {pct(should)}%.",
                [{"icon": "star", "tone": "good",
                  "title": "Ghi nhận và duy trì" if manager else "Giữ nhịp làm việc hiện tại",
                  "detail": "Nhân viên đang đi đúng kế hoạch, có thể ghi nhận trong buổi họp tới." if manager
                            else "Tiến độ đang ổn, cứ tiếp tục làm đều mỗi ngày."}])

    if manager:
        goal_gap = r1(w.expected_progress - w.actual_progress)
        progress_status = (f"chậm {pct(goal_gap)} điểm phần trăm"
                           if goal_gap > 0 else "đạt/vượt tiến độ kỳ vọng")
        feedback = (
            f'Mục tiêu cần chú ý: “{w.name}” ({label}). Tiến độ thực tế '
            f"{pct(w.actual_progress)}%, kỳ vọng {pct(w.expected_progress)}% ({progress_status})."
        )
        if overdue:
            feedback += f" Toàn bộ mục tiêu có {overdue} đầu việc quá hạn."

        actions = []
        if goal_gap > 0:
            actions.append({
                "icon": "trending_down", "tone": "warn",
                "title": f"{w.name}: chậm {pct(goal_gap)} điểm",
                "detail": f"Tiến độ thực tế {pct(w.actual_progress)}%, so với kỳ vọng {pct(w.expected_progress)}%."
            })
        for goal, task in items[:3]:
            date = "/".join(reversed(task.due_date.split("-"))) if task.due_date else "không rõ hạn"
            actions.append({
                "icon": "event_busy", "tone": "bad",
                "title": f"Quá hạn: {task.name}",
                "detail": f'Mục tiêu “{goal}” · hạn {date} · trễ {task.days_late} ngày.'
            })
        if not actions:
            actions.append({
                "icon": "info", "tone": "warn",
                "title": "Mục tiêu cần theo dõi",
                "detail": f'“{w.name}” ở mức {label}; chưa ghi nhận chậm tiến độ hoặc đầu việc quá hạn.'
            })
        return feedback, actions

    who = "Nhân viên này" if manager else "Bạn"
    level = "có nguy cơ cao không kịp hạn" if label == "High Risk" else "đang chậm so với kế hoạch"
    feedback = (f"{who} {level}. Đến hôm nay lẽ ra đã xong khoảng {pct(should)}% công việc, "
                f"nhưng mới xong {pct(done)}%."
                + (f" Hiện có {overdue} đầu việc đã quá hạn." if overdue else "")
                + f" Mục tiêu cần chú ý nhất là “{w.name}”.")

    actions = []
    if items:
        goal, top = items[0]
        date = "/".join(reversed(top.due_date.split("-")))
        info = f"Việc này thuộc mục tiêu “{goal}”, hạn {date}, đã trễ {top.days_late} ngày. "
        actions.append({
            "icon": "forum" if manager else "priority_high", "tone": "bad",
            "title": f"Hỏi nhân viên về việc “{top.name}”" if manager else f"Làm trước việc trễ lâu nhất: “{top.name}”",
            "detail": info + ("Hỏi xem việc đang vướng ở đâu rồi thống nhất ngày hoàn thành mới." if manager
                              else "Nếu cần thêm thời gian, hãy báo quản lý để thống nhất hạn mới.")})
        if len(items) > 1:
            names = ", ".join(f"“{it.name}” (trễ {it.days_late} ngày)" for _, it in items[1:4])
            actions.append({
                "icon": "checklist", "tone": "warn",
                "title": f"{'Rà soát' if manager else 'Xử lý tiếp'} {len(items) - 1} việc quá hạn còn lại",
                "detail": f"Gồm: {names}. " + ("Xem việc nào có thể giao bớt hoặc dời hạn." if manager
                                               else "Làm lần lượt từ việc trễ lâu nhất.")})
    if behind >= 5:
        actions.append({
            "icon": "tune" if manager else "timer", "tone": "warn",
            "title": "Cân nhắc dời hạn hoặc chia bớt việc" if manager else "Xếp lịch làm việc cho từng ngày",
            "detail": f"Công việc đang chậm khoảng {pct(behind)}% so với kế hoạch, mục tiêu gần hạn nhất {when}. "
                      + ("Nếu thấy khó kịp, hãy dời hạn hoặc giao bớt việc cho người khác." if manager
                         else "Hãy chia phần việc còn lại ra từng ngày.")})
    if not actions:
        actions.append({"icon": "chat", "tone": "warn", "title": "Trao đổi với quản lý",
                        "detail": "Tiến độ chưa chậm nhiều nhưng thời gian còn ít. Hãy xác nhận lại kế hoạch cho phần việc còn lại."})
    return feedback, actions

@app.get("/")
def root():
    return {"status": "AI server is running"}

@app.get("/health")
def health():
    return {"status": "ok", "features": FEATURES}


@app.post("/predict")
def predict(body: PredictIn):
    goals = body.goals
    if not goals:
        return {"risk_label": "Normal", "shapFactors": [], "feedback": "Chưa có mục tiêu đang chạy.",
                "actions": [], "worst_goal": "", "goals": []}

    X = np.array([to_row(g) for g in goals], dtype=np.float32)
    proba = booster.predict(xgb.DMatrix(X, feature_names=FEATURES))   # (số goal, 3 lớp)
    classes = proba.argmax(axis=1)

    # Goal xấu nhất: lớp rủi ro cao nhất, hòa thì lấy goal có xác suất High Risk lớn hơn
    worst = max(range(len(goals)), key=lambda i: (int(classes[i]), float(proba[i, HIGH])))
    label = LABELS[int(classes[worst])]

    # SHAP (TreeSHAP của XGBoost) của goal xấu nhất, theo lớp High Risk:
    # giá trị dương = đẩy về High Risk, âm = kéo xa High Risk. Đơn vị là log-odds.
    contribs = np.asarray(booster.predict(
        xgb.DMatrix(X[worst:worst + 1], feature_names=FEATURES), pred_contribs=True))
    contribs = contribs.reshape(1, len(LABELS), len(FEATURES) + 1)
    impacts = contribs[0, HIGH, :-1]
    factors = [
        {"feature": f, "label": LABEL_VI.get(f, f), "impact": round(float(v), 2)}
        for f, v in zip(FEATURES, impacts)
    ]
    factors.sort(key=lambda x: abs(x["impact"]), reverse=True)
    factors = factors[:5]

    feedback, actions = build_text(goals, goals[worst], label, body.audience == "manager")
    return {
        "risk_label": label,
        "shapFactors": factors,
        "feedback": feedback,
        "actions": actions,
        "worst_goal": goals[worst].name,
        "goals": [
            {"name": g.name, "risk_label": LABELS[int(classes[i])], "p_high": round(float(proba[i, HIGH]), 3)}
            for i, g in enumerate(goals)
        ],
    }