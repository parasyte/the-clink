FROM ubuntu:26.04

# Create an unprivileged user and setup environment
RUN useradd --create-home --shell /bin/bash user && \
    mkdir -p /home/user/models && \
    chown user:user /home/user/models

# Install Dependencies
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates cmake curl git gnupg2 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Download models
# NOTE: Keeping models in the image makes the server start up much faster.
RUN curl --proto '=https' --tlsv1.2 -fSL -o /home/user/models/mmproj-BF16.gguf \
        https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-BF16.gguf && \
    curl --proto '=https' --tlsv1.2 -fSL -o /home/user/models/Qwen3.8-27B-UD-Q4_K_XL.gguf \
        https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf && \
    chown user:user /home/user/models/* && \
    chmod 0644 /home/user/models/*

# Install NVIDIA driver and CUDA toolkit
RUN curl --proto '=https' --tlsv1.2 -fsSLo /tmp/cuda-keyring_1.1-1_all.deb \
        https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2604/x86_64/cuda-keyring_1.1-1_all.deb && \
    dpkg -i /tmp/cuda-keyring_1.1-1_all.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends cuda-drivers cuda-toolkit && \
    rm -rf /tmp/*

# Build llama.cpp
ARG LLAMA_COMMIT=18b5f8b1862ebfe0f1c33d2355b81a54d2fec867
RUN git clone https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp && \
    git -C /tmp/llama.cpp checkout "${LLAMA_COMMIT}" && \
    cd /tmp/llama.cpp && \
    export PATH="/usr/local/cuda/bin/:$PATH" && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON && \
    cmake --build build --config Release -j --target llama-cli llama-server && \
    cp /tmp/llama.cpp/build/bin/llama-cli /usr/local/bin/ && \
    cp /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/ && \
    rm -rf /tmp/*

# Run as an unprivileged user
USER user
WORKDIR /home/user
RUN mkdir -p /home/user/.config/llama.cpp

# Copy configuration
COPY --chown=user:user llama/config.ini /home/user/.config/llama.cpp/config.ini

CMD ["/usr/local/bin/llama-server", "--models-preset", "/home/user/.config/llama.cpp/config.ini"]
