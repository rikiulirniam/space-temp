from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import sqlite3
import numpy as np
import os
import uvicorn

# Machine Learning
from sklearn.cluster import DBSCAN
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
import xgboost as xgb

app = FastAPI(title="Smart Session Analysis API")

# CORS config
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = os.path.join(os.path.dirname(__file__), "monitoring.db")

@app.get("/api/analyze")
def analyze_session(session_id: int = Query(..., description="ID of the session to analyze")):
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=500, detail="Database not found")

    try:
        # 1. Load Data
        conn = sqlite3.connect(DB_PATH)
        query = f"""
            SELECT id, waktu, suhu, kelembapan, COALESCE(presence_status, 'empty') as presence_status 
            FROM sensor_data 
            WHERE session_id = {session_id} 
            ORDER BY waktu ASC
        """
        df = pd.read_sql_query(query, conn)
        conn.close()

        if df.empty:
            raise HTTPException(status_code=404, detail=f"No data found for session {session_id}")

        if len(df) < 5:
            raise HTTPException(status_code=400, detail="Not enough data points for analysis (minimum 5 required)")

        # Prepare base features
        X = df[['suhu', 'kelembapan']].values
        time_series = df['waktu'].tolist()
        
        # Scale features for DBSCAN
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        # ---------------------------------------------------------
        # ALGORITHM 1: DBSCAN (Clustering / Anomaly Detection)
        # ---------------------------------------------------------
        # eps and min_samples tuned heuristically for generic room temp/humidity
        dbscan = DBSCAN(eps=0.5, min_samples=5)
        clusters = dbscan.fit_predict(X_scaled)
        
        # -1 indicates anomaly, everything else is a normal cluster
        dbscan_result = []
        for i, label in enumerate(clusters):
            dbscan_result.append({
                "x": float(df.iloc[i]['suhu']),
                "y": float(df.iloc[i]['kelembapan']),
                "anomaly": bool(label == -1)
            })

        # ---------------------------------------------------------
        # ALGORITHM 2: Random Forest (Classification)
        # ---------------------------------------------------------
        # Here we try to train an RF model to classify presence_status based on suhu and kelembapan
        y = df['presence_status'].values
        
        # If there's only one class in the data, Random Forest will fail to split.
        unique_classes, counts = np.unique(y, return_counts=True)
        rf_result = {}
        
        if len(unique_classes) > 1:
            rf_model = RandomForestClassifier(n_estimators=50, random_state=42)
            rf_model.fit(X, y)
            predictions = rf_model.predict(X)
            pred_classes, pred_counts = np.unique(predictions, return_counts=True)
            total = sum(pred_counts)
            for cls, count in zip(pred_classes, pred_counts):
                rf_result[cls] = float(count / total * 100)
        else:
            # Only one class present, just return 100% for it
            rf_result[unique_classes[0]] = 100.0

        # ---------------------------------------------------------
        # ALGORITHM 3: XGBoost (Regression / Smoothing Trend)
        # ---------------------------------------------------------
        # We'll use XGBoost to smooth the temperature over time index
        # Time index (0, 1, 2, ...) as feature to predict temperature
        X_time = np.arange(len(df)).reshape(-1, 1)
        y_temp = df['suhu'].values

        xgb_model = xgb.XGBRegressor(n_estimators=50, max_depth=3, learning_rate=0.1)
        xgb_model.fit(X_time, y_temp)
        
        # Predict trend (smoothing)
        temp_trend = xgb_model.predict(X_time)
        
        xgb_result = {
            "waktu": time_series,
            "aktual": df['suhu'].tolist(),
            "prediksi": temp_trend.tolist()
        }

        # ---------------------------------------------------------
        # Return Aggregated JSON
        # ---------------------------------------------------------
        return {
            "session_id": session_id,
            "total_data": len(df),
            "dbscan": dbscan_result,
            "random_forest": rf_result,
            "xgboost": xgb_result
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5001)