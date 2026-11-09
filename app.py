
import os
import re
from pathlib import Path

from flask import Flask, request, jsonify
from groq import Groq
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"), override=True)

app = Flask(__name__)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
ML_API_KEY = os.getenv("ML_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


@app.get("/")
def home():
    return jsonify({
        "message": "Kisan to Kreta ML API is running",
        "status": "success"
    })


@app.post("/predict")
def predict():
    if not ML_API_KEY:
        return jsonify({"error": "ML_API_KEY is not configured"}), 500

    if request.headers.get("Authorization") != f"Bearer {ML_API_KEY}":
        return jsonify({"error": "Unauthorized"}), 401

    if client is None:
        return jsonify({"error": "GROQ_API_KEY is not configured"}), 500

    data = request.get_json(silent=True) or {}
    prices = data.get("prices")

    if not isinstance(prices, list) or not prices:
        return jsonify({"error": "Price history is required"}), 400

    try:
        history = []

        for item in prices:
            price = float(item["price"])

            if price <= 0:
                raise ValueError("Prices must be positive")

            history.append({
                "date": str(item.get("date", "")),
                "price": round(price, 2)
            })

        history.sort(key=lambda item: item["date"])

        prompt = f"""
You are an agricultural market price estimation assistant.

Crop ID: {data.get("crop_id", "Unknown")}

Historical market prices:
{history}

Estimate the next market price per kg using the historical trend.

Rules:
1. Consider the historical price trend.
2. Do not invent external market data.
3. Return one positive numeric price only.
4. Do not include currency symbols or explanations.
"""

        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "Return only one positive numeric price."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            temperature=0.2,
            max_tokens=30
        )

        answer = response.choices[0].message.content.strip()
        match = re.search(r"\d+(?:\.\d+)?", answer)

        if not match:
            raise ValueError("AI returned an invalid price")

        predicted_price = float(match.group())

        if not predicted_price > 0:
            raise ValueError("AI returned a non-positive price")

        return jsonify({
            "status": "success",
            "crop_id": data.get("crop_id"),
            "predicted_price": round(predicted_price, 2),
            "currency": "INR/kg",
            "prediction_source": "groq_flask"
        })

    except (KeyError, TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400

    except Exception as error:
        app.logger.exception("Prediction failed")
        return jsonify({
            "error": "AI prediction failed",
            "details": str(error)
        }), 502


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False
    )
