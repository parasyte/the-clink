FROM ubuntu:26.04

# Create an unprivileged user and setup environment
RUN echo 'test -f ~/.bashrc && . ~/.bashrc' >/etc/skel/.bash_profile && \
    useradd --create-home --shell /bin/bash user

# Install Dependencies
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates cmake curl git libssl-dev pkg-config python3 python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install tools
ARG FD_VERSION=10.4.2
ARG RG_VERSION=15.2.0
RUN curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/fd.tar.gz" \
        "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/fd.tar.gz -C /tmp/ "fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl/fd" && \
    mv "/tmp/fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl/fd" /usr/local/bin/ && \
    curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/rg.tar.gz" \
        "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/rg.tar.gz -C /tmp/ "ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl/rg" && \
    mv "/tmp/ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl/rg" /usr/local/bin/ && \
    rm -rf /tmp/*

# Run as an unprivileged user
USER user
WORKDIR /home/user

# Install Rust toolchain
ARG RUST_VERSION=1.99.0
# Fastly was extremely slow today.
# Workaround: https://github.com/rust-lang/rust/issues/119496#issuecomment-1881125322
ENV RUSTUP_DIST_SERVER=https://cloudfront-static.rust-lang.org
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- \
        -y --profile minimal --default-toolchain "$RUST_VERSION" --no-update-default-toolchain && \
    /home/user/.cargo/bin/rustup component add clippy rustfmt && \
    rm -rf /home/user/.rustup/downloads /home/user/.rustup/tmp

# Install nvm and nodejs
ENV NVM_DIR=/home/user/.nvm
ARG NVM_VERSION=0.40.7
ARG NODE_VERSION=24.21.0
ARG NPM_VERSION=12.2.0
RUN curl --proto '=https' --tlsv1.2 -fsSL \
        "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install "$NODE_VERSION" && \
    npm install -g --ignore-scripts --omit=dev --no-audit --no-fund "npm@$NPM_VERSION"

# Install pi.dev
ARG PI_VERSION=1.1.0
RUN . "$NVM_DIR/nvm.sh" && \
    npm install -g --ignore-scripts --omit=dev --no-audit --no-fund \
        "@earendil-works/pi-coding-agent@${PI_VERSION}"
COPY .pi /home/user/.pi

# Install dependencies for the RAG extension
RUN cd /home/user/.pi/agent/extensions/meilisearch && \
    . "$NVM_DIR/nvm.sh" && \
    npm install --omit=dev --no-audit --no-fund

CMD ["bash", "-i", "-c", "pi; exec bash"]
