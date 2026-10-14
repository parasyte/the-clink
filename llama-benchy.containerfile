FROM ubuntu:26.04

# Create an unprivileged user and setup environment
RUN useradd --create-home --shell /bin/bash user

# Install Dependencies
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates curl git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user
USER user
WORKDIR /home/user

# Install uv
RUN curl --proto '=https' --tlsv1.2 -fsSL https://astral.sh/uv/install.sh | sh

# Install llama-benchy
ARG BENCHY_COMMIT=e9be344578cec17745066b220798b80a0d2686d3
RUN git clone https://github.com/eugr/llama-benchy.git && \
    git -C llama-benchy checkout "${BENCHY_COMMIT}" && \
    . "$HOME/.local/bin/env" && \
    uv venv && \
    uv pip install --directory llama-benchy --editable .

# Install tokenizer
RUN . .venv/bin/activate && \
    llama-benchy --base-url http://localhost:9931/v1 --model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL \
        --tokenizer Qwen/Qwen-tokenizer >/dev/null ; \
    exit 0

CMD ["bash", "-i", "-c", "source .venv/bin/activate && \
    llama-benchy --base-url http://host.containers.internal:9931/v1 \
        --model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL --tokenizer Qwen/Qwen-tokenizer \
        --pp 512 --tg 128 --depth 0 4096 8192"]
