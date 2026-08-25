FROM ubuntu:26.04

# Create an unprivileged user and setup environment
RUN useradd --create-home --shell /bin/bash user && \
    mkdir -p /home/user/.config/llama.cpp && \
    mkdir /home/user/llama

# Install Dependencies
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends build-essential ca-certificates cmake curl git gnupg2

# Download the models
RUN curl --proto '=https' --tlsv1.2 -fSL -o /home/user/llama/mmproj-BF16.gguf \
    https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-BF16.gguf
RUN curl --proto '=https' --tlsv1.2 -fSL -o /home/user/llama/Qwen3.8-27B-UD-Q4_K_XL.gguf \
    https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf

# Install NVIDIA driver and CUDA toolkit
RUN curl --proto '=https' --tlsv1.2 -fsSLo /tmp/cuda-keyring_1.1-1_all.deb \
        https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2604/x86_64/cuda-keyring_1.1-1_all.deb && \
    dpkg -i /tmp/cuda-keyring_1.1-1_all.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends cuda-drivers cuda-toolkit-13-3

# Build llama.cpp
RUN git clone https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp && \
    cd /tmp/llama.cpp && \
    export PATH="/usr/local/cuda/bin/:$PATH" && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON && \
    cmake --build build --config Release -j --target llama-cli llama-server

# Copy llama.cpp
RUN cp /tmp/llama.cpp/build/bin/llama-cli /home/user/llama/ && \
    cp /tmp/llama.cpp/build/bin/llama-server /home/user/llama/
COPY llama/config.ini /home/user/.config/llama.cpp/config.ini

# Cleanup
RUN apt-get autoclean && \
    apt-get autoremove && \
    rm -rf /tmp/*

# Fix file permissions
RUN chown -R user:user /home/user

# Run as an unprivileged user
USER user
WORKDIR /home/user/llama

CMD ["/home/user/llama/llama-server", "--models-preset", "/home/user/.config/llama.cpp/config.ini"]
