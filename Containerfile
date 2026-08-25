FROM ubuntu:26.04 AS models

# Create an unprivileged user and setup environment
RUN echo 'test -f ~/.bashrc && . ~/.bashrc' >/etc/skel/.bash_profile && \
    echo '. $HOME/.cargo/env' >>/etc/skel/.bash_profile && \
    useradd --create-home --shell /bin/bash user && \
    mkdir /home/user/.pi && \
    mkdir -p /home/user/.config/llama.cpp && \
    mkdir /home/user/llama && \
    mkdir /home/user/app

# Install curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl

# Download the models
RUN curl --proto '=https' --tlsv1.2 -fSL -o /home/user/llama/mmproj-BF16.gguf \
    https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-BF16.gguf
RUN curl --proto '=https' --tlsv1.2 -fSL -o /home/user/llama/Qwen3.8-27B-UD-Q4_K_XL.gguf \
    https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf

# Fix file permissions
RUN chown -R user:user /home/user


FROM models AS base

# Install Dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential cmake git gnupg2 nodejs npm

# Install NVIDIA driver and CUDA toolkit
RUN curl --proto '=https' --tlsv1.2 -fsSLo /tmp/cuda-keyring_1.1-1_all.deb \
        https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2604/x86_64/cuda-keyring_1.1-1_all.deb && \
    dpkg -i /tmp/cuda-keyring_1.1-1_all.deb && \
    apt-get update && \
    apt-get install -y --no-install-recommends cuda-drivers cuda-toolkit-13-3

# Install Rust toolchain
ENV CARGO_HOME=/home/user/.cargo
ENV RUSTUP_HOME=/home/user/.rustup
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y

# Install tools
ENV FD_VERSION=10.4.2
ENV RG_VERSION=15.2.0
RUN curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/fd.tar.gz" \
        "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/fd.tar.gz -C /tmp/ "fd-v${FD_VERSION}-x86_64-unknown-linux-musl/fd" && \
    mv "/tmp/fd-v${FD_VERSION}-x86_64-unknown-linux-musl/fd" /usr/local/bin/ && \
    curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/rg.tar.gz" \
        "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/rg.tar.gz -C /tmp/ "ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg" && \
    mv "/tmp/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg" /usr/local/bin/

# Cleanup
RUN apt-get autoclean && \
    apt-get autoremove && \
    rm -rf /tmp/*


FROM base AS builder

# Build llama.cpp
RUN git clone https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp && \
    cd /tmp/llama.cpp && \
    export PATH="/usr/local/cuda/bin/:$PATH" && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON && \
    cmake --build build --config Release -j --target llama-cli llama-server


FROM base AS final

# Install pi.dev
RUN curl --proto '=https' --tlsv1.2 -fsSL https://pi.dev/install.sh | sh
COPY .pi/agent /home/user/.pi/agent

# Copy llama.cpp
COPY --from=builder /tmp/llama.cpp/build/bin/llama-cli /home/user/llama/
COPY --from=builder /tmp/llama.cpp/build/bin/llama-server /home/user/llama/
COPY llama/config.ini /home/user/.config/llama.cpp/config.ini

# Fix file permissions
RUN chown -R user:user /home/user

# Run as an unprivileged user
USER user
WORKDIR /home/user/app

CMD ["bash", "-l", "-c", "pi; exec bash -l"]
