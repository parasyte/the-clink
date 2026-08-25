# The Clanker Clink

Containerize `pi.dev` and `llama.cpp`.


## Configure podman-machine

> [!IMPORTANT]
> Do not skip this step. `podman-machine` requires the NVIDIA Container Toolkit to access to your GPU.

```bash
podman machine ssh 'curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
    tee /etc/yum.repos.d/nvidia-container-toolkit.repo && \
    yum install -y nvidia-container-toolkit && \
    nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml && \
    nvidia-ctk cdi list'
```


## Build the container

Compiling `llama.cpp` needs to access your GPU to auto-detect the native architecture for optimizations.

```bash
podman build --device nvidia.com/gpu=all --tag the-clink .
```


## Running the service

Install `podman-compose` through [Podman Desktop](https://podman-desktop.io/docs/compose/setting-up-compose) or manually by downloading [a release](https://github.com/docker/compose/releases).

From within your project's working directory:

```bash
podman compose up -d
```


## Running `pi`

Run `pi` in your project directory:

```bash
podman run -it --rm --name pi --network the-clink_default \
    -v "$(echo $HOME | sed 's#^/c/#/c:/#')/.pi/agent/sessions:/home/user/.pi/agent/sessions" \
    -v "$(echo $PWD | sed 's#^/c/#/c:/#'):/home/user/$(basename $PWD)" \
    the-clink \
    bash -l -c "cd /home/user/$(basename $PWD); pi; exec bash -l"
```

<kbd>Ctrl+D</kbd> will exit `pi` to a shell, and <kbd>Ctrl+D</kbd> from the shell will detach from the container. `podman` will automatically restart `pi`. The shell allows use of the `pi` CLI.


## Tailing `llama.cpp` logs

```bash
podman logs -f the-clink-llama
```


## Tips

1. Running `pi` with the long command is no fun. Create a shell alias for it. I called mine `cc`, for Clanker Clink 🤣!

2. Running inference on an RTX 3090 or higher can use a lot of power needlessly. Power limiting the GPU to 250 W or so retains most of the performance at ~70% of the cost.

    Run as Administrator in a Windows terminal:

    ```bash
    nvidia-smi -pl 250
    ```

3. The default `llama.cpp` config is optimized for a single 3090. You can replace it and rebuild the image quickly. `podman` will reuse the cached layers containing the model, CUDA Toolkit, and `llama.cpp`.
