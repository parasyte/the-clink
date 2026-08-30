FROM ubuntu:26.04

# Create an unprivileged user and setup environment
RUN echo 'test -f ~/.bashrc && . ~/.bashrc' >/etc/skel/.bash_profile && \
    useradd --create-home --shell /bin/bash user && \
    mkdir /home/user/.pi && \
    mkdir /home/user/app

# Install Dependencies
RUN apt-get update && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends build-essential ca-certificates cmake curl git \
        gnupg2 nodejs npm

# Install Rust toolchain
ENV CARGO_HOME=/home/user/.cargo
ENV RUSTUP_HOME=/home/user/.rustup
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y

# Install tools
ENV FD_VERSION=10.4.2
ENV RG_VERSION=15.2.0
RUN curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/fd.tar.gz" \
        "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/fd.tar.gz -C /tmp/ "fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl/fd" && \
    mv "/tmp/fd-v${FD_VERSION}-$(uname -m)-unknown-linux-musl/fd" /usr/local/bin/ && \
    curl --proto '=https' --tlsv1.2 -fsSL -o "/tmp/rg.tar.gz" \
        "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" && \
    tar -xzf /tmp/rg.tar.gz -C /tmp/ "ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl/rg" && \
    mv "/tmp/ripgrep-${RG_VERSION}-$(uname -m)-unknown-linux-musl/rg" /usr/local/bin/

# Install pi.dev
RUN curl --proto '=https' --tlsv1.2 -fsSL https://pi.dev/install.sh | sh
COPY .pi/agent /home/user/.pi/agent

# Cleanup
RUN apt-get autoclean && \
    apt-get autoremove && \
    rm -rf /tmp/*

# Fix file permissions
RUN chown -R user:user /home/user

# Run as an unprivileged user
USER user
WORKDIR /home/user/app

# Add Rust toolchain to the PATH
RUN sed -i 's@^# for examples$@# for examples\n\n. /home/user/.cargo/env@' /home/user/.bashrc

CMD ["bash", "-c", "pi; exec bash"]
