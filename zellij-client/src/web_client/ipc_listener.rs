use axum_server::Handle;
use zellij_utils::consts::WEBSERVER_SOCKET_PATH;
use zellij_utils::web_server_commands::InstructionForWebServer;

#[cfg(unix)]
use tokio::io::AsyncReadExt;
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

#[cfg(unix)]
pub async fn create_webserver_receiver(
    id: &str,
) -> Result<UnixStream, Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(&WEBSERVER_SOCKET_PATH.as_path())?;
    let socket_path = WEBSERVER_SOCKET_PATH.join(format!("{}", id));

    if socket_path.exists() {
        tokio::fs::remove_file(&socket_path).await?;
    }

    let listener = UnixListener::bind(&socket_path)?;
    let (stream, _) = listener.accept().await?;
    Ok(stream)
}

#[cfg(unix)]
pub async fn receive_webserver_instruction(
    receiver: &mut UnixStream,
) -> std::io::Result<InstructionForWebServer> {
    let mut buffer = Vec::new();
    receiver.read_to_end(&mut buffer).await?;
    let cursor = std::io::Cursor::new(buffer);
    rmp_serde::decode::from_read(cursor)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

#[cfg(unix)]
pub async fn listen_to_web_server_instructions(server_handle: Handle, id: &str) {
    loop {
        let receiver = create_webserver_receiver(id).await;
        match receiver {
            Ok(mut receiver) => {
                match receive_webserver_instruction(&mut receiver).await {
                    Ok(instruction) => match instruction {
                        InstructionForWebServer::ShutdownWebServer => {
                            server_handle.shutdown();
                            break;
                        },
                    },
                    Err(e) => {
                        log::error!("Failed to process web server instruction: {}", e);
                        // Continue loop to recreate receiver and try again
                    },
                }
            },
            Err(e) => {
                log::error!("Failed to listen to ipc channel: {}", e);
                break;
            },
        }
    }
}

// Windows implementation using named pipes
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use zellij_utils::windows_utils::named_pipe::{Pipe, PipeStream};

#[cfg(windows)]
pub async fn create_webserver_receiver(
    id: &str,
) -> Result<PipeStream, Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(&WEBSERVER_SOCKET_PATH.as_path())?;
    let socket_path = WEBSERVER_SOCKET_PATH.join(format!("{}", id));

    // Create marker file for discovery
    let _ = std::fs::File::create(&socket_path);

    let pipe = Pipe::new(&socket_path);
    // Use blocking accept in a spawn_blocking context
    let stream = tokio::task::spawn_blocking(move || pipe.accept())
        .await
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)??;
    Ok(stream)
}

#[cfg(windows)]
pub async fn receive_webserver_instruction(
    receiver: &mut PipeStream,
) -> std::io::Result<InstructionForWebServer> {
    // Read synchronously since PipeStream doesn't implement AsyncRead
    let mut buffer = Vec::new();
    receiver.read_to_end(&mut buffer)?;
    let cursor = std::io::Cursor::new(buffer);
    rmp_serde::decode::from_read(cursor)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

#[cfg(windows)]
pub async fn listen_to_web_server_instructions(server_handle: Handle, id: &str) {
    loop {
        let receiver = create_webserver_receiver(id).await;
        match receiver {
            Ok(mut receiver) => {
                match receive_webserver_instruction(&mut receiver).await {
                    Ok(instruction) => match instruction {
                        InstructionForWebServer::ShutdownWebServer => {
                            server_handle.shutdown();
                            break;
                        },
                    },
                    Err(e) => {
                        log::error!("Failed to process web server instruction: {}", e);
                        // Continue loop to recreate receiver and try again
                    },
                }
            },
            Err(e) => {
                log::error!("Failed to listen to ipc channel: {}", e);
                break;
            },
        }
    }
}
