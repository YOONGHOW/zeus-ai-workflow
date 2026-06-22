# Use Python 3.12 slim version as base
FROM python:3.12-slim

# Install system dependencies required for OpenCV, PaddleOCR, and other libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the Python backend scripts and config files
COPY py_script/ ./py_script/
COPY service_account.json ./service_account.json
COPY oauth.json ./oauth.json

# Set env port variable default (Cloud Run will override this)
ENV PORT=8000
EXPOSE 8000

# Run the backend server
CMD ["python", "py_script/server.py"]
