## The Clanker Clink automation system
##
## List available recipes with `just --list`

# Override the default container runtime (podman) with an environment variable named `CRUN`:
#
# ```
# export CRUN=docker
# just build
# ```
runtime := env_var_or_default('CRUN', 'podman')

project := 'the-clink'

# Build a single container.
[arg("verbose", short="v", value="true")]
_build name verbose="false" *device_flags:
    @echo "Building container '{{name}}'..."
    @{{runtime}} build {{device_flags}} --tag {{project}}-{{name}}:latest -f {{name}}.containerfile . \
        {{ if verbose == "true" { "" } else { f"> ./build/{{name}}-build.output" } }}
    @{{ if verbose == "true" { "" } else { f"echo 'Build output written to ./build/{{name}}-build.output'" } }}

# Build all containers.
[arg("verbose", short="v", value="true")]
build verbose="false": (_build "llama-cuda" verbose "--device" "nvidia.com/gpu=all") (_build "pi" verbose)
    @echo "The Clanker Clink is ready"

# Install a shell function into your profile for running the pi container.
install:
    #!/usr/bin/env bash
    if [[ -f "$HOME/.bashrc" ]] ; then
        if [[ -z $(grep "# Added by the-clink" "$HOME/.bashrc") ]] ; then
            echo "Updating profile: $HOME/.bashrc"

            echo >>"$HOME/.bashrc"
            echo "# Added by the-clink" >>"$HOME/.bashrc"
            echo ". $PWD/env" >>"$HOME/.bashrc"

            . "$PWD/env"
        else
            echo "Previous installation detected. Not updating."
        fi
    fi

    echo "The Clanker Clink has been installed to your default profile as 'clink'"

# Install the required NVIDIA Container Toolkit dependency.
install-nct:
    @podman machine ssh --username root \
        'curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
        tee /etc/yum.repos.d/nvidia-container-toolkit.repo && \
        yum install -y nvidia-container-toolkit && \
        nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml && \
        nvidia-ctk cdi list'

# Remove all build artifacts.
clean:
    @rm -f ./build/*
