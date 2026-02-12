pipeline {
    agent any
    environment {
        PATH = "${WORKSPACE}:${PATH}"
    }
    stages {
        stage('Setup Tools') {
            steps {
                script {
                    // Ha nincs docker vagy kubectl, letöltjük (ez a rész maradhat a régi)
                    if (!fileExists('docker/docker')) {
                        sh 'curl -fsSLO https://download.docker.com/linux/static/stable/x86_64/docker-24.0.5.tgz'
                        sh 'tar xzvf docker-24.0.5.tgz --strip 1 -C . docker/docker'
                    }
                    if (!fileExists('kubectl')) {
                        sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                        sh 'chmod +x kubectl'
                    }
                }
            }
        }
        stage('Build Docker Image') {
            steps {
                sh './docker build -t my-node-app:latest ./app'
            }
        }
        stage('Deploy to K8s') {
            steps {
                sh './kubectl replace --force -f k8s/deployment.yaml' 
                // A 'replace --force' drasztikusabb mint a 'apply', jobban takarít
            }
        }
    }
    post {
        always {
            // EZ AZ ÚJ RÉSZ: Töröljük a "dangling" (felesleges) image-eket
            sh './docker image prune -f'
        }
    }
}