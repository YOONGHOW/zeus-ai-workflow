# Use Python 3.12 slim version as base
FROM python:3.12-slim

# Install system dependencies required for OpenCV, PaddleOCR, and other libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libjpeg62-turbo \
    libopenjp2-7 \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the Python backend scripts
COPY py_script/ ./py_script/

# Set env port variable default (Cloud Run will override this)
ENV PORT=8080
EXPOSE 8080

# Run the backend server
CMD ["python", "py_script/server.py"]
